'use strict';

class ServerlessFargateTasks {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.service = serverless.service;
    this.provider = serverless.getProvider('aws');
    this.options = options || {};
    this.debug = this.options.debug || process.env.SLS_DEBUG;
    this.colors = get(this.serverless, 'processedInput.options.color', true);
    this.hooks = {
      'package:compileFunctions': this.compileTasks.bind(this)
    };

    this.nameWithStage = this.service.service + '-' + options.stage
  }

  compileTasks() {
    const template = this.serverless.service.provider.compiledCloudFormationTemplate;
    const colors = this.colors;
    const options = this.serverless.service.custom.fargate;
    const debug = this.debug;
    const consoleLog = this.serverless.cli.consoleLog;

    if (debug) consoleLog(yellow('Fargate Tasks Plugin'));

    // add the cluster
    template['Resources']['FargateTasksCluster'] = {
      "Type" : "AWS::ECS::Cluster",
    }

    // Create a loggroup for the logs
    template['Resources']['FargateTasksLogGroup'] = {
      "Type" : "AWS::Logs::LogGroup",
    }

    // for each defined task, we create a service and a task, and point it to
    // the created cluster
    Object.keys(options.tasks).forEach(identifier => {
      if (debug) consoleLog(yellow('Processing ' + identifier));
      // consoleLog(options.tasks[identifier]);

      // get all override values, if they exists
      var override = options.tasks[identifier]['override'] || {}
      var container_override = override['container'] || {}
      var task_override = override['task'] || {}
      var service_override = override['service'] || {}
      var network_override = override['network'] || {}

      var name = options.tasks[identifier]['name'] || identifier
      var normalizedIdentifier = this.provider.naming.normalizeNameToAlphaNumericOnly(identifier)

      // consoleLog(override);
      if (!override.hasOwnProperty('role')) {
        // check if the default role can be assumed by ecs, if not, make it so
        if(template.Resources.IamRoleLambdaExecution.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service.indexOf('ecs-tasks.amazonaws.com') == -1) {
          template.Resources.IamRoleLambdaExecution.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service.push('ecs-tasks.amazonaws.com')

          // check if there already is a ManagedPolicyArns array, if not, create it
          if(!template.Resources.IamRoleLambdaExecution.Properties.hasOwnProperty('ManagedPolicyArns')) {
            template.Resources.IamRoleLambdaExecution.Properties['ManagedPolicyArns'] = [];
          }
          template.Resources.IamRoleLambdaExecution.Properties['ManagedPolicyArns'].push('arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy')
        }
      }

      // create a key/value list for the task environment
      let environment = []
      if(options.tasks[identifier].hasOwnProperty('environment')) {

        // when a global environment is set, we need to extend it
        var target_environment = options['environment'] || {}
        target_environment = Object.assign(target_environment, options.tasks[identifier].environment)

        Object.keys(target_environment).forEach(function(key,index) {
          let value = target_environment[key];
          environment.push({"Name": key, "Value": value})
        })
      }

      // create the container definition
      var definitions = Object.assign({
        'Name': name,
        'Image': options.tasks[identifier]['image'],
        'Environment': environment,
        'LogConfiguration': {
          'LogDriver': 'awslogs',
          'Options': {
            'awslogs-region':{"Fn::Sub": "${AWS::Region}"},
            'awslogs-group': {"Fn::Sub": "${FargateTasksLogGroup}"},
            'awslogs-stream-prefix': 'fargate'
          },
        },
      }, container_override)

      // create the task definition
      var task = {
        'Type': 'AWS::ECS::TaskDefinition',
        'Properties': Object.assign({
          'ContainerDefinitions': [definitions],
          'Family': name,
          'NetworkMode': 'awsvpc',
          'ExecutionRoleArn': options['role'] || {"Fn::Sub": 'arn:aws:iam::${AWS::AccountId}:role/ecsTaskExecutionRole'},
          'TaskRoleArn': override['role'] || {"Fn::Sub": '${IamRoleLambdaExecution}'},
          'RequiresCompatibilities': ['FARGATE'],
          'Memory': options.tasks[identifier]['memory'] || "0.5GB",
          'Cpu': options.tasks[identifier]['cpu'] || 256,
        }, task_override)
      }
      template['Resources'][normalizedIdentifier + 'Task'] = task

      let desired = options.tasks[identifier]['desired']

      // check for optional service if set

      let allowService = true
      if(options.tasks[identifier]['allowService'] === false) {
        allowService = false
      }
      if (allowService) {
        // create the service definition
        var service = {
          'Type': 'AWS::ECS::Service',
          'Properties': Object.assign({
            'Cluster': {"Fn::Sub": '${FargateTasksCluster}'},
            'LaunchType': 'FARGATE',
            'ServiceName': name,
            'DesiredCount': desired == undefined ? 1 : desired,
            'TaskDefinition': {"Fn::Sub": '${' + normalizedIdentifier + 'Task}'},
            'NetworkConfiguration': {
              'AwsvpcConfiguration': Object.assign({
                'AssignPublicIp': options.vpc['public-ip'] || "DISABLED",
                'SecurityGroups': options.vpc['security-groups'] || [],
                'Subnets': options.vpc['subnets'] || [],
              }, network_override),
            }
          }, service_override)
        }
        template['Resources'][normalizedIdentifier + 'Service'] = service
      }
      // create the autoscaling definitions if required
      const autoscaling = options.tasks[identifier]['autoscaling']
      if (autoscaling != null) {
        var autoScalingRole = {
          Type: 'AWS::IAM::Role',
          Properties: {
            RoleName: this.nameWithStage + '-' + name + '-auto-scaling-role',
            AssumeRolePolicyDocument: {
              Statement: [
                {
                  "Effect": "Allow",
                  "Principal": {
                    "Service": "ecs-tasks.amazonaws.com"
                  },
                  "Action": "sts:AssumeRole"
                },
              ]
            },
            ManagedPolicyArns: [
              'arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceAutoscaleRole'
            ]
          }
        }
        template['Resources'][normalizedIdentifier + 'AutoScalingRole'] = autoScalingRole

        var autoScalingTarget = {
          "Type": "AWS::ApplicationAutoScaling::ScalableTarget",
          "DependsOn": [normalizedIdentifier + 'Service'],
          "Properties": {
            "MinCapacity": autoscaling.minCapacity || 1,
            "MaxCapacity": autoscaling.maxCapacity || 1,
            "ResourceId": {
              "Fn::Join": [
                "/",
                ["service", { "Ref": "FargateTasksCluster" }, name]
              ]
            },
            "ScalableDimension": "ecs:service:DesiredCount",
            "ServiceNamespace": "ecs",
            "RoleARN": { "Fn::GetAtt": [normalizedIdentifier + "AutoScalingRole", "Arn"] }
          }
        }
        template['Resources'][normalizedIdentifier + 'AutoScalingTarget'] = autoScalingTarget

        var autoScalingPolicy = {
          "Type": "AWS::ApplicationAutoScaling::ScalingPolicy",
          "Properties": {
            "PolicyName": this.nameWithStage + '-' + name + "-auto-scaling-policy",
            "PolicyType": "TargetTrackingScaling",
            "ScalingTargetId": { "Ref": normalizedIdentifier + 'AutoScalingTarget' },
            "TargetTrackingScalingPolicyConfiguration": {
              "PredefinedMetricSpecification": {
                "PredefinedMetricType": autoscaling.metricType || 'ECSServiceAverageCPUUtilization'
              },
              "ScaleInCooldown": autoscaling.scaleInCooldown || 300,
              "ScaleOutCooldown": autoscaling.scaleOutCooldown || 300,
              "TargetValue": autoscaling.targetValue || 50
            }
          }
        }
        template['Resources'][normalizedIdentifier + 'AutoScalingPolicy'] = autoScalingPolicy
      }
    });

    function yellow(str) {
      if (colors) return '\u001B[33m' + str + '\u001B[39m';
      return str;
    }
  }
}

function get(obj, path, def) {
  return path.split('.').filter(Boolean).every(step => !(step && (obj = obj[step]) === undefined)) ? obj : def;
}

module.exports = ServerlessFargateTasks;


