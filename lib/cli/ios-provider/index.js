module.exports.command = 'ios-provider [name]'

module.exports.describe = 'Start an iOS provider unit scaffold.'

function normalizeMode(value) {
  var normalized = String(value || 'disabled').trim().toLowerCase()
  return ['disabled', 'host-bridge'].indexOf(normalized) !== -1 ?
    normalized :
    'disabled'
}

module.exports.builder = function(yargs) {
  var os = require('os')

  return yargs
    .env('STF_IOS')
    .strict()
    .option('connect-push', {
      alias: 'p'
    , describe: 'Device-side ZeroMQ PULL endpoint to connect to.'
    , array: true
    , default: []
    })
    .option('connect-sub', {
      alias: 's'
    , describe: 'Device-side ZeroMQ PUB endpoint to connect to.'
    , array: true
    , default: []
    })
    .option('mode', {
      describe: 'iOS provider runtime mode.'
    , type: 'string'
    , choices: ['disabled', 'host-bridge']
    , default: normalizeMode(process.env.STF_IOS_PROVIDER_MODE)
    , coerce: normalizeMode
    })
    .option('name', {
      describe: 'An easily identifiable name for the UI and/or log output.'
    , type: 'string'
    , default: os.hostname()
    })
    .option('provider', {
      describe: 'Provider scope name used for metrics/logging.'
    , type: 'string'
    })
    .option('public-ip', {
      describe: 'Public host/IP used to generate iOS screen URLs.'
    , type: 'string'
    , default: process.env.STF_IOS_PUBLIC_IP || 'localhost'
    })
    .option('storage-url', {
      describe: 'Storage base URL used for iOS install downloads.'
    , type: 'string'
    })
    .option('ios-deploy-path', {
      describe: 'Path to ios-deploy binary.'
    , type: 'string'
    , default: process.env.STF_IOS_IOS_DEPLOY_PATH || '/usr/local/bin/ios-deploy'
    })
    .option('xcode-developer-dir', {
      describe: 'Xcode developer directory used for devicectl fallback.'
    , type: 'string'
    , default: process.env.STF_IOS_XCODE_DEVELOPER_DIR || '/Applications/Xcode.app/Contents/Developer'
    })
    .option('action-timeout', {
      describe: 'Timeout in milliseconds for install/uninstall/launch actions.'
    , type: 'number'
    , default: 300000
    })
    .option('screen-ws-url-pattern', {
      describe: 'URL pattern used to publish iOS screen websocket URL.'
    , type: 'string'
    , default: process.env.STF_IOS_SCREEN_WS_URL_PATTERN || 'wss://${publicIp}/frames/${providerIp}/${videoPort}/x'
    })
    .option('wda-host', {
      describe: 'Host/IP for WDA HTTP endpoint access.'
    , type: 'string'
    , default: process.env.STF_IOS_WDA_HOST || '127.0.0.1'
    })
    .option('coordinator-event-connect-sub', {
      describe: 'Coordinator event PUB endpoint(s) to connect to.'
    , array: true
    , default: [process.env.STF_IOS_COORDINATOR_EVENT_CONNECT_SUB || 'tcp://127.0.0.1:7294']
    })
    .option('coordinator-event-topic', {
      describe: 'Coordinator event topic to subscribe to.'
    , type: 'string'
    , default: process.env.STF_IOS_COORDINATOR_EVENT_TOPIC || 'devEvent'
    })
    .option('poll-interval', {
      describe: 'Scaffold polling interval in milliseconds.'
    , type: 'number'
    , default: 10000
    })
    .epilog('Each option can be be overwritten with an environment variable ' +
      'by converting the option to uppercase, replacing dashes with ' +
      'underscores and prefixing it with `STF_IOS_` (e.g. ' +
      '`STF_IOS_MODE`).')
}

module.exports.handler = function(argv) {
  return require('../../units/ios-provider')({
    name: argv.name
  , provider: argv.provider
  , publicIp: argv.publicIp
  , storageUrl: argv.storageUrl
  , iosDeployPath: argv.iosDeployPath
  , xcodeDeveloperDir: argv.xcodeDeveloperDir
  , actionTimeout: argv.actionTimeout
  , screenWsUrlPattern: argv.screenWsUrlPattern
  , wdaHost: argv.wdaHost
  , coordinatorEventEndpoints: argv.coordinatorEventConnectSub
  , coordinatorEventTopic: argv.coordinatorEventTopic
  , mode: argv.mode
  , pollInterval: argv.pollInterval
  , endpoints: {
      push: argv.connectPush
    , sub: argv.connectSub
    }
  })
}
