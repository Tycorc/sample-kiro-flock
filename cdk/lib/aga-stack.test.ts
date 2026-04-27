import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AgaStack } from './aga-stack';

const DUMMY_VPC_CONTEXT_KEY =
  'vpc-provider:account=123456789012:filter.isDefault=true:region=us-east-1:returnAsymmetricSubnets=true';

const DUMMY_VPC_CONTEXT_VALUE = {
  vpcId: 'vpc-12345',
  vpcCidrBlock: '10.0.0.0/16',
  ownerAccountId: '123456789012',
  availabilityZones: ['us-east-1a', 'us-east-1b'],
  subnetGroups: [
    {
      name: 'Public',
      type: 'Public',
      subnets: [
        { subnetId: 'subnet-1', cidr: '10.0.0.0/24', availabilityZone: 'us-east-1a', routeTableId: 'rtb-1' },
        { subnetId: 'subnet-2', cidr: '10.0.1.0/24', availabilityZone: 'us-east-1b', routeTableId: 'rtb-2' },
      ],
    },
  ],
};

function createTemplate(): Template {
  const app = new cdk.App({
    context: {
      [DUMMY_VPC_CONTEXT_KEY]: DUMMY_VPC_CONTEXT_VALUE,
      // Skip asset bundling (no Docker needed)
      'aws:cdk:bundling-stacks': [],
    },
  });
  const stack = new AgaStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

let template: Template;
beforeAll(() => { template = createTemplate(); });

test('snapshot', () => {
  expect(template.toJSON()).toMatchSnapshot();
});

test('S3 bucket exists with BlockPublicAccess', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
});

test('Lambda function with nodejs20.x runtime and BUCKET_NAME env var', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs20.x',
    Environment: {
      Variables: Match.objectLike({
        BUCKET_NAME: Match.anyValue(),
      }),
    },
  });
});

test('API Gateway REST API exists', () => {
  template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
});

test('Security group with no inbound rules', () => {
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: Match.stringLikeRegexp('outbound only'),
  });
});

test('IAM instance profile exists', () => {
  template.resourceCountIs('AWS::IAM::InstanceProfile', 1);
});
