import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const DEFAULT_CONFIG = {
  concurrency: 3,
  neighbourRadius: 1,
  instanceType: 't4g.medium',
  loopIntervalSeconds: 30,
  model: null,
  idleTimeoutSeconds: 300,
};

export class AgaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------- Build the agent bundle up-front (synth-time step) ----------
    // esbuild-bundles agent/bootstrap.ts + copies runtime assets into
    // dist/agent-bundle/. BucketDeployment zips and uploads this folder.
    const repoRoot = path.resolve(__dirname, '..', '..');
    execSync('node scripts/build-agent-bundle.js', {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    const agentBundleDir = path.join(repoRoot, 'dist', 'agent-bundle');

    // ---------- VPC ----------
    // Single-AZ public subnet, IGW attached. Agents get public IPs so they
    // can reach S3 / Kiro endpoints without a NAT gateway.
    const vpc = new ec2.Vpc(this, 'AgaVpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    const sg = new ec2.SecurityGroup(this, 'AgentSg', {
      vpc,
      description: 'AGA agent instances - outbound only',
      allowAllOutbound: true,
    });

    // ---------- S3 bucket ----------
    const accessLogsBucket = new s3.Bucket(this, 'AgaAccessLogsBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });

    const bucket = new s3.Bucket(this, 'AgaBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'access-logs/',
    });

    // Web dashboard assets → s3://bucket/web/
    new s3deploy.BucketDeployment(this, 'WebAssets', {
      sources: [s3deploy.Source.asset(path.join(repoRoot, 'web'))],
      destinationBucket: bucket,
      destinationKeyPrefix: 'web',
      prune: false,
    });

    // Agent bundle → s3://bucket/agent/*
    new s3deploy.BucketDeployment(this, 'AgentBundle', {
      sources: [s3deploy.Source.asset(agentBundleDir)],
      destinationBucket: bucket,
      destinationKeyPrefix: 'agent',
      prune: false,
    });

    // Seed initial cluster config
    new s3deploy.BucketDeployment(this, 'SeedConfig', {
      sources: [
        s3deploy.Source.jsonData('config.json', DEFAULT_CONFIG),
      ],
      destinationBucket: bucket,
      prune: false,
    });

    // ---------- IAM for EC2 agents ----------
    const agentRole = new iam.Role(this, 'AgentRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    // Scoped S3 access: agents can only read/write specific prefixes.
    // They must not touch web/*, agent/*, config.json, or history/*.
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [
        bucket.arnForObjects('agent/*'),
        bucket.arnForObjects('store/*'),
        bucket.arnForObjects('output/*'),
        bucket.arnForObjects('knowledge-base/*'),
        bucket.arnForObjects('config.json'),
        bucket.arnForObjects('direction.md'),
      ],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [
        bucket.arnForObjects('store/*'),
        bucket.arnForObjects('output/*'),
        bucket.arnForObjects('knowledge-base/*'),
      ],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
      conditions: {
        StringLike: {
          's3:prefix': ['agent/*', 'store/*', 'output/*', 'knowledge-base/*'],
        },
      },
    }));
    // Explicit deny on sensitive prefixes as defence-in-depth.
    // direction.md is included to prevent agents from altering their own instructions.
    // Only the Lambda (operator) may write it.
    agentRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: ['s3:PutObject', 's3:DeleteObject'],
      resources: [
        bucket.arnForObjects('web/*'),
        bucket.arnForObjects('agent/*'),
        bucket.arnForObjects('history/*'),
        bucket.arnForObjects('config.json'),
        bucket.arnForObjects('direction.md'),
      ],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));
    // SSM managed instance core — lets us connect via Session Manager if needed
    agentRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    );
    // Allow agents to read the Kiro API key from SSM Parameter Store
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:*:${this.account}:parameter/aga/kiro-api-key`],
    }));
    const instanceProfile = new iam.CfnInstanceProfile(this, 'AgentInstanceProfile', {
      roles: [agentRole.roleName],
    });

    // ---------- AMI ----------
    const amiImage = ec2.MachineImage.latestAmazonLinux2023({
      cpuType: ec2.AmazonLinuxCpuType.ARM_64,
    });
    // Resolve the AMI ID for this stack's region at synth time so the Lambda
    // can pass it straight through to RunInstances.
    const amiId = amiImage.getImage(this).imageId;

    // ---------- Lambda ----------
    const fn = new NodejsFunction(this, 'IncubatorFn', {
      entry: path.join(repoRoot, 'lambda/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(120),
      environment: {
        BUCKET_NAME: bucket.bucketName,
        AMI_ID: amiId,
        SECURITY_GROUP_ID: sg.securityGroupId,
        INSTANCE_PROFILE_ARN: instanceProfile.attrArn,
        SUBNET_ID: vpc.publicSubnets[0].subnetId,
        CONCURRENCY_CAP: '64',
      },
    });
    bucket.grantReadWrite(fn);
    // RunInstances: restrict instance type to Graviton families. Split into two
    // statements because ec2:InstanceType only applies to the instance resource
    // type — other resource types (volume, ENI, etc.) would fail the condition.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:RunInstances'],
      resources: [`arn:aws:ec2:*:${this.account}:instance/*`],
      conditions: {
        StringLike: { 'ec2:InstanceType': ['t*g.*', 'c*g.*', 'm*g.*', 'r*g.*'] },
      },
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:RunInstances'],
      resources: [
        `arn:aws:ec2:*:${this.account}:volume/*`,
        `arn:aws:ec2:*:${this.account}:network-interface/*`,
        `arn:aws:ec2:*:${this.account}:security-group/*`,
        `arn:aws:ec2:*:${this.account}:subnet/*`,
        `arn:aws:ec2:*::image/*`,
        `arn:aws:ec2:*:${this.account}:key-pair/*`,
      ],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ec2:DescribeInstances',
        'ec2:DescribeInstanceTypes',
        'ec2:CreateTags',
      ],
      resources: ['*'],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:TerminateInstances'],
      resources: [`arn:aws:ec2:*:${this.account}:instance/*`],
      conditions: {
        StringEquals: { 'aws:ResourceTag/Project': 'kiro-flock' },
      },
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricData'],
      resources: ['*'],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [agentRole.roleArn],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['servicequotas:GetServiceQuota'],
      resources: ['*'],
    }));
    // Allow the Lambda to invoke itself asynchronously for long-running
    // start operations that would exceed the API Gateway 29s timeout.
    // Uses a wildcard ARN to avoid circular dependency between the function,
    // its role policy, and the API Gateway deployment. The handler only ever
    // invokes itself (via AWS_LAMBDA_FUNCTION_NAME).
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:AgaStack-*`],
    }));

    // ---------- Cognito ----------
    const userPool = new cognito.UserPool(this, 'FlockUserPool', {
      userPoolName: 'kiro-flock-users',
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Cognito hosted UI domain (uses a prefix on the Cognito domain)
    const cognitoDomain = userPool.addDomain('FlockDomain', {
      cognitoDomain: {
        domainPrefix: `kiro-flock-${cdk.Aws.ACCOUNT_ID}`,
      },
    });

    // App client for the dashboard (PKCE flow, no client secret)
    const userPoolClient = userPool.addClient('FlockDashboardClient', {
      userPoolClientName: 'flock-dashboard',
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { implicitCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID],
        // Placeholder only — install.sh updates this to the real API Gateway URL
        // via aws cognito-idp update-user-pool-client after deploy.
        callbackUrls: ['https://localhost/callback'],
        logoutUrls: ['https://localhost/'],
      },
      preventUserExistenceErrors: true,
    });

    // ---------- API Gateway (REST API v1 — required for WAF) ----------
    const api = new apigw.RestApi(this, 'AgaApi', {
      restApiName: 'aga-api',
      deployOptions: {
        stageName: 'prod',
      },
      binaryMediaTypes: ['*/*'],
    });

    // Cognito authorizer for API endpoints
    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'FlockAuthorizer', {
      cognitoUserPools: [userPool],
      authorizerName: 'flock-cognito-auth',
    });

    // /cluster/{proxy+} → Lambda (Cognito-protected)
    const cluster = api.root.addResource('cluster');
    const clusterProxy = cluster.addResource('{proxy+}');
    clusterProxy.addMethod('ANY', new apigw.LambdaIntegration(fn), {
      requestParameters: {
        'method.request.path.proxy': true,
      },
      authorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
    });

    // Role API Gateway uses to read from S3
    const apiS3Role = new iam.Role(this, 'ApiS3Role', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });
    bucket.grantRead(apiS3Role);

    // GET / → s3://bucket/web/index.html
    api.root.addMethod('GET', new apigw.AwsIntegration({
      service: 's3',
      integrationHttpMethod: 'GET',
      path: `${bucket.bucketName}/web/index.html`,
      options: {
        credentialsRole: apiS3Role,
        integrationResponses: [{
          statusCode: '200',
          responseParameters: {
            'method.response.header.Content-Type': 'integration.response.header.Content-Type',
          },
        }],
      },
    }), {
      methodResponses: [{
        statusCode: '200',
        responseParameters: { 'method.response.header.Content-Type': true },
      }],
    });

    // GET /{proxy+} → s3://bucket/web/{proxy}
    const rootProxy = api.root.addResource('{proxy+}');
    rootProxy.addMethod('GET', new apigw.AwsIntegration({
      service: 's3',
      integrationHttpMethod: 'GET',
      path: `${bucket.bucketName}/web/{proxy}`,
      options: {
        credentialsRole: apiS3Role,
        requestParameters: {
          'integration.request.path.proxy': 'method.request.path.proxy',
        },
        integrationResponses: [{
          statusCode: '200',
          responseParameters: {
            'method.response.header.Content-Type': 'integration.response.header.Content-Type',
          },
        }],
      },
    }), {
      requestParameters: {
        'method.request.path.proxy': true,
      },
      methodResponses: [{
        statusCode: '200',
        responseParameters: { 'method.response.header.Content-Type': true },
      }],
    });

    // ---------- WAF ----------
    const ipSet = new wafv2.CfnIPSet(this, 'AllowedIps', {
      name: 'aga-allowed-ips',
      scope: 'REGIONAL',
      ipAddressVersion: 'IPV4',
      addresses: [],
    });

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: 'aga-web-acl',
      scope: 'REGIONAL',
      defaultAction: { block: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: false,
        metricName: 'aga-web-acl',
        sampledRequestsEnabled: false,
      },
      rules: [{
        name: 'AllowFromIpSet',
        priority: 0,
        action: { allow: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: false,
          metricName: 'aga-allow-ip',
          sampledRequestsEnabled: false,
        },
        statement: {
          ipSetReferenceStatement: { arn: ipSet.attrArn },
        },
      }],
    });

    new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${api.restApiId}/stages/${api.deploymentStage.stageName}`,
      webAclArn: webAcl.attrArn,
    });

    // ---------- Outputs ----------
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'SecurityGroupId', { value: sg.securityGroupId });
    new cdk.CfnOutput(this, 'SubnetId', { value: vpc.publicSubnets[0].subnetId });
    new cdk.CfnOutput(this, 'InstanceProfileArn', { value: instanceProfile.attrArn });
    new cdk.CfnOutput(this, 'AmiId', { value: amiId });
    new cdk.CfnOutput(this, 'WafIpSetId', { value: ipSet.attrId, description: 'WAF IP set ID — pass to scripts/update-ip.sh' });
    new cdk.CfnOutput(this, 'WafIpSetName', { value: 'aga-allowed-ips' });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'CognitoDomain', {
      value: `${cognitoDomain.domainName}.auth.${this.region}.amazoncognito.com`,
    });
  }
}
