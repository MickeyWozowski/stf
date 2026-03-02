module.exports.command = 'flash-samsung <action>'

module.exports.describe = 'Manage Samsung flash jobs and worker lifecycle.'

module.exports.builder = function(yargs) {
  return yargs
    .env('STF_FLASH_SAMSUNG')
    .strict()
    .option('name', {
      describe: 'An identifiable worker name for logs.'
    , type: 'string'
    , default: 'flash-samsung-001'
    })
    .option('provider', {
      describe: 'Provider scope for worker claimed jobs.'
    , type: 'string'
    })
    .option('poll-interval', {
      describe: 'Worker poll interval in milliseconds.'
    , type: 'number'
    , default: 3000
    })
    .option('execution-mode', {
      describe: 'Worker execution mode.'
    , type: 'string'
    , choices: ['dry-run', 'execute', 'disabled']
    , default: 'dry-run'
    })
    .option('execution-backend', {
      describe: 'Execution backend to use for queued Samsung jobs.'
    , type: 'string'
    , choices: ['mac-dev-local', 'linux-provider']
    , default: 'mac-dev-local'
    })
    .option('serial', {
      describe: 'Device serial for enqueue/list filtering.'
    , type: 'string'
    })
    .option('package-ref', {
      describe: 'Firmware package reference or identifier.'
    , type: 'string'
    })
    .option('created-by', {
      describe: 'User email or actor creating the job.'
    , type: 'string'
    , default: 'system'
    })
    .option('target-build', {
      describe: 'Optional target build label for audit.'
    , type: 'string'
    })
    .option('manifest-version', {
      describe: 'Optional manifest schema version.'
    , type: 'string'
    })
    .option('manifest-path', {
      describe: 'Optional local JSON manifest path to inject in metadata.'
    , type: 'string'
    })
    .option('manifest-json', {
      describe: 'Optional inline JSON manifest to inject in metadata.manifest.'
    , type: 'string'
    })
    .option('destructive-confirmation', {
      describe: 'Required confirmation marker for execute mode.'
    , type: 'string'
    })
    .option('simulate', {
      describe: 'Simulate executor command path with non-destructive echo checks.'
    , type: 'boolean'
    , default: false
    })
    .option('device-csc', {
      describe: 'Device CSC value used for strict compatibility checks.'
    , type: 'string'
    })
    .option('device-bootloader', {
      describe: 'Device bootloader string used for strict compatibility checks.'
    , type: 'string'
    })
    .option('environment-profile', {
      describe: 'Policy environment profile for mac-dev-local guardrails.'
    , type: 'string'
    })
    .option('allow-mac-dev-local', {
      describe: 'Allow mac-dev-local execute mode.'
    , type: 'boolean'
    })
    .option('allow-writes', {
      describe: 'Allow manifest flash write actions in execute mode.'
    , type: 'boolean'
    })
    .option('allowed-serials', {
      describe: 'Comma-separated serial allowlist for execute mode.'
    , type: 'string'
    })
    .option('allowed-package-prefixes', {
      describe: 'Comma-separated packageRef allowlist prefixes for execute mode.'
    , type: 'string'
    })
    .option('confirmation-phrase', {
      describe: 'Expected destructive confirmation phrase.'
    , type: 'string'
    })
    .option('require-admin', {
      describe: 'Require admin/root actor for execute mode.'
    , type: 'boolean'
    , default: false
    })
    .option('message', {
      describe: 'Optional initial job message.'
    , type: 'string'
    })
    .option('metadata', {
      describe: 'Optional JSON metadata object.'
    , type: 'string'
    , default: '{}'
    })
    .option('id', {
      describe: 'Flash job identifier.'
    , type: 'string'
    })
    .option('status', {
      describe: 'Status filter for list.'
    , type: 'string'
    })
    .option('limit', {
      describe: 'Maximum jobs returned by list.'
    , type: 'number'
    , default: 20
    })
    .option('reason', {
      describe: 'Cancellation reason.'
    , type: 'string'
    })
}

module.exports.handler = function(argv) {
  var logger = require('../../util/logger')
  var log = logger.createLogger('cli:flash-samsung')
  var dbapi = require('../../db/api')

  if (['worker', 'enqueue', 'list', 'get', 'cancel'].indexOf(argv.action) === -1) {
    log.fatal('Invalid action "%s"', argv.action)
    process.exit(1)
  }

  function parseMetadata() {
    var metadata = {}

    try {
      metadata = JSON.parse(argv.metadata || '{}')
    }
    catch (err) {
      throw new Error('Invalid JSON in --metadata')
    }

    if (argv.manifestPath) {
      metadata.manifestPath = argv.manifestPath
    }

    if (argv.manifestJson) {
      try {
        metadata.manifest = JSON.parse(argv.manifestJson)
      }
      catch (err) {
        throw new Error('Invalid JSON in --manifest-json')
      }
    }

    if (argv.destructiveConfirmation) {
      metadata.destructiveConfirmation = argv.destructiveConfirmation
    }

    if (argv.simulate) {
      metadata.simulate = true
    }

    if (argv.deviceCsc || argv.deviceBootloader) {
      metadata.deviceInfo = Object.assign({}, metadata.deviceInfo || {}, {
        csc: argv.deviceCsc || (metadata.deviceInfo && metadata.deviceInfo.csc)
      , bootloader: argv.deviceBootloader || (metadata.deviceInfo && metadata.deviceInfo.bootloader)
      })
    }

    return metadata
  }

  function printAndExit(payload, code) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
    process.exit(code || 0)
  }

  if (argv.action === 'worker') {
    if (argv.executionMode === 'disabled') {
      log.info('Samsung flash worker disabled by execution mode')
      return
    }

    return require('../../units/flash-samsung')({
      name: argv.name
    , provider: argv.provider
    , pollInterval: argv.pollInterval
    , executionMode: argv.executionMode
    , executionBackend: argv.executionBackend
    , allowMacDevLocal: argv.allowMacDevLocal
    , allowWrites: argv.allowWrites
    , environmentProfile: argv.environmentProfile
    , allowedSerials: argv.allowedSerials
    , allowedPackagePrefixes: argv.allowedPackagePrefixes
    , confirmationPhrase: argv.confirmationPhrase
    , requireAdmin: argv.requireAdmin
    })
  }

  if (argv.action === 'enqueue') {
    if (!argv.serial || !argv.packageRef) {
      log.fatal('enqueue requires --serial and --package-ref')
      process.exit(1)
    }

    return dbapi.loadDeviceBySerial(argv.serial)
      .then(function(device) {
        if (!device) {
          throw new Error('Device not found in STF database')
        }
        return dbapi.createFlashJob({
          deviceSerial: argv.serial
        , provider: argv.provider || (device.provider && device.provider.name) || null
        , createdBy: argv.createdBy
        , packageRef: argv.packageRef
        , manifestVersion: argv.manifestVersion
        , targetBuild: argv.targetBuild
        , message: argv.message
        , executionMode: argv.executionMode
        , executionBackend: argv.executionBackend
        , metadata: parseMetadata()
        })
      })
      .then(function(job) {
        printAndExit({
          success: true
        , job: job
        })
      })
      .catch(function(err) {
        log.fatal('Failed to enqueue flash job: %s', err.stack || err.message)
        process.exit(1)
      })
  }

  if (argv.action === 'list') {
    return dbapi.listFlashJobs({
      status: argv.status
    , deviceSerial: argv.serial
    , createdBy: argv.createdBy !== 'system' ? argv.createdBy : null
    , limit: argv.limit
    })
      .then(function(jobs) {
        printAndExit({
          success: true
        , count: jobs.length
        , jobs: jobs
        })
      })
      .catch(function(err) {
        log.fatal('Failed to list flash jobs: %s', err.stack || err.message)
        process.exit(1)
      })
  }

  if (argv.action === 'get') {
    if (!argv.id) {
      log.fatal('get requires --id')
      process.exit(1)
    }

    return dbapi.getFlashJob(argv.id)
      .then(function(job) {
        if (!job) {
          printAndExit({
            success: false
          , description: 'Flash job not found'
          }, 1)
          return
        }

        printAndExit({
          success: true
        , job: job
        })
      })
      .catch(function(err) {
        log.fatal('Failed to get flash job: %s', err.stack || err.message)
        process.exit(1)
      })
  }

  if (argv.action === 'cancel') {
    if (!argv.id) {
      log.fatal('cancel requires --id')
      process.exit(1)
    }

    return dbapi.cancelFlashJob(argv.id, argv.createdBy, argv.reason)
      .then(function(job) {
        if (!job) {
          printAndExit({
            success: false
          , description: 'Flash job cannot be canceled from current state'
          }, 1)
          return
        }

        printAndExit({
          success: true
        , job: job
        })
      })
      .catch(function(err) {
        log.fatal('Failed to cancel flash job: %s', err.stack || err.message)
        process.exit(1)
      })
  }
}
