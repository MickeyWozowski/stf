var os = require('os')
var cp = require('child_process')

var Promise = require('bluebird')

var errors = require('../errors')

var allowedHeimdallOps = {
  version: true
, detect: true
, 'print-pit': true
, flash: true
}

function flashError(code, message, details) {
  return errors.create(code, message, details)
}

function pushLog(buffer, line) {
  if (!line) {
    return
  }
  buffer.push(line)
  if (buffer.length > 400) {
    buffer.splice(0, buffer.length - 400)
  }
}

function emitLog(onEvent, buffer, level, line) {
  emitLogWithMeta(onEvent, buffer, level, line, null)
}

function emitLogWithMeta(onEvent, buffer, level, line, meta) {
  pushLog(buffer, line)
  if (onEvent) {
    var payload = Object.assign({
        type: 'log'
      , level: level || 'info'
      , line: line
      , at: new Date()
      }, meta || {})
    onEvent(payload)
  }
}

function parseLines(stream, onLine) {
  var pending = ''
  stream.on('data', function(chunk) {
    pending += chunk.toString()
    var split = pending.split(/\r?\n/)
    pending = split.pop()
    split.forEach(function(line) {
      onLine(line)
    })
  })
  stream.on('end', function() {
    if (pending) {
      onLine(pending)
    }
  })
}

function assertAllowedInvocation(command, args) {
  if (command === 'echo') {
    return
  }

  if (command === 'adb') {
    if (!args.length || args[0] !== 'devices') {
      throw flashError('COMMAND_NOT_ALLOWED', 'Only "adb devices" is permitted in mac-dev-local backend')
    }
    return
  }

  if (command !== 'heimdall') {
    throw flashError('COMMAND_NOT_ALLOWED', 'Command is not allowlisted for mac-dev-local backend', {
      command: command
    })
  }

  var operation = args[0]
  if (!allowedHeimdallOps[operation]) {
    throw flashError('COMMAND_NOT_ALLOWED', 'Heimdall operation is not allowlisted', {
      operation: operation
    })
  }

  if (operation === 'flash') {
    if (args.length < 3 || args.length % 2 === 0) {
      throw flashError('COMMAND_NOT_ALLOWED', 'Invalid Heimdall flash argument structure')
    }

    for (var i = 1; i < args.length; i += 2) {
      if (!/^--[A-Z0-9_]+$/.test(args[i])) {
        throw flashError('COMMAND_NOT_ALLOWED', 'Invalid Heimdall flash partition argument', {
          argument: args[i]
        })
      }
    }
  }
}

function runCommand(command, args, opts, onEvent, logs, eventMeta) {
  assertAllowedInvocation(command, args)

  var meta = eventMeta || {}
  var commandId = meta.commandId ||
    ('cmd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8))
  var commandLine = command + ' ' + args.join(' ')
  var startedAt = Date.now()
  var commandContext = {
      eventType: 'command'
    , phase: 'start'
    , stream: 'stdin'
    , commandId: commandId
    , command: command
    , args: args.slice()
    , step: meta.step || null
    , actionType: meta.actionType || null
    , partition: meta.partition || null
    , artifactId: meta.artifactId || null
    }

  emitLogWithMeta(onEvent, logs, 'info', 'exec> ' + commandLine, commandContext)

  return new Promise(function(resolve, reject) {
    var child = null

    try {
      child = cp.spawn(command, args, {
        cwd: opts.cwd || process.cwd()
      , env: opts.env || process.env
      })
    }
    catch (err) {
      emitLogWithMeta(onEvent, logs, 'error', 'spawn error: ' + (err && err.message ? err.message : err), {
          eventType: 'command'
        , phase: 'error'
        , commandId: commandId
        , command: command
        , args: args.slice()
        , step: meta.step || null
        })
      reject(err)
      return
    }

    emitLogWithMeta(onEvent, logs, 'info', 'spawned pid=' + child.pid, {
        eventType: 'command'
      , phase: 'spawned'
      , commandId: commandId
      , command: command
      , args: args.slice()
      , pid: child.pid
      , step: meta.step || null
      , actionType: meta.actionType || null
      , partition: meta.partition || null
      , artifactId: meta.artifactId || null
      })

    child.on('error', function(err) {
      emitLogWithMeta(onEvent, logs, 'error', 'command error: ' + (err && err.message ? err.message : err), {
          eventType: 'command'
        , phase: 'error'
        , commandId: commandId
        , command: command
        , args: args.slice()
        , pid: child.pid
        , step: meta.step || null
        })

      if (err && err.code === 'ENOENT') {
        reject(flashError('COMMAND_NOT_FOUND', 'Required executable is missing on host', {
          command: command
        }))
        return
      }
      reject(err)
    })

    parseLines(child.stdout, function(line) {
      emitLogWithMeta(onEvent, logs, 'info', line, {
          eventType: 'io'
        , stream: 'stdout'
        , commandId: commandId
        , command: command
        , args: args.slice()
        , pid: child.pid
        , step: meta.step || null
        , actionType: meta.actionType || null
        , partition: meta.partition || null
        , artifactId: meta.artifactId || null
        })
    })
    parseLines(child.stderr, function(line) {
      emitLogWithMeta(onEvent, logs, 'warn', line, {
          eventType: 'io'
        , stream: 'stderr'
        , commandId: commandId
        , command: command
        , args: args.slice()
        , pid: child.pid
        , step: meta.step || null
        , actionType: meta.actionType || null
        , partition: meta.partition || null
        , artifactId: meta.artifactId || null
        })
    })

    child.on('close', function(code, signal) {
      var durationMs = Date.now() - startedAt

      if (signal) {
        emitLogWithMeta(onEvent, logs, 'error', 'command exited by signal ' + signal, {
            eventType: 'command'
          , phase: 'exit'
          , commandId: commandId
          , command: command
          , args: args.slice()
          , pid: child.pid
          , code: code
          , signal: signal
          , durationMs: durationMs
          , step: meta.step || null
          , actionType: meta.actionType || null
          , partition: meta.partition || null
          , artifactId: meta.artifactId || null
          })
        reject(flashError('COMMAND_SIGNAL', 'Command exited due to signal', {
          command: command
        , signal: signal
        }))
        return
      }

      if (code !== 0) {
        emitLogWithMeta(onEvent, logs, 'error', 'command exited with non-zero status ' + code, {
            eventType: 'command'
          , phase: 'exit'
          , commandId: commandId
          , command: command
          , args: args.slice()
          , pid: child.pid
          , code: code
          , durationMs: durationMs
          , step: meta.step || null
          , actionType: meta.actionType || null
          , partition: meta.partition || null
          , artifactId: meta.artifactId || null
          })
        reject(flashError('COMMAND_EXIT_NONZERO', 'Command exited with non-zero status', {
          command: command
        , code: code
        }))
        return
      }

      emitLogWithMeta(onEvent, logs, 'info', 'command completed successfully', {
          eventType: 'command'
        , phase: 'exit'
        , commandId: commandId
        , command: command
        , args: args.slice()
        , pid: child.pid
        , code: code
        , durationMs: durationMs
        , step: meta.step || null
        , actionType: meta.actionType || null
        , partition: meta.partition || null
        , artifactId: meta.artifactId || null
        })
      resolve()
    })
  })
}

function buildActionCommand(action, artifactsById, allowWrites) {
  if (action.type === 'heimdall-detect') {
    return {
        command: 'heimdall'
      , args: ['detect']
      }
  }

  if (action.type === 'heimdall-print-pit') {
    return {
        command: 'heimdall'
      , args: ['print-pit', '--no-reboot']
      }
  }

  if (action.type === 'heimdall-flash') {
    if (!allowWrites) {
      throw flashError(
        'FLASH_WRITES_BLOCKED',
        'Manifest contains a flash write action but write policy is disabled'
      )
    }

    return {
        command: 'heimdall'
      , args: ['flash', '--' + action.partition, artifactsById[action.artifact].resolvedPath]
      }
  }

  throw flashError('INVALID_MANIFEST', 'Unsupported action type in executor', {
    type: action.type
  })
}

module.exports = function(options) {
  var opts = options || {}
  var logs = []

  function emit(onEvent, message, level) {
    if (onEvent) {
      onEvent({
          type: 'status'
        , message: message
        , level: level || 'info'
        })
    }
  }

  return {
    prepare: function(context, onEvent) {
      if (os.platform() !== 'darwin' && !context.simulate) {
        throw flashError('BACKEND_PLATFORM_MISMATCH', 'mac-dev-local backend can run only on macOS hosts')
      }

      emit(onEvent, 'Preparing mac-dev-local Samsung executor')

      if (context.simulate) {
        return runCommand('echo', ['Simulated prepare step'], opts, onEvent, logs, {
          step: 'prepare'
        , actionType: 'prepare-simulated'
        })
      }

      return runCommand('heimdall', ['version'], opts, onEvent, logs, {
        step: 'prepare'
      , actionType: 'heimdall-version'
      })
    }

  , flash: function(context, onEvent) {
      var artifactsById = Object.create(null)
      context.manifest.artifacts.forEach(function(artifact) {
        artifactsById[artifact.id] = artifact
      })

      if (context.simulate) {
        return Promise.map(context.manifest.actions, function(action) {
            emit(onEvent, 'Simulating action ' + action.type)
            return runCommand('echo', ['Simulated ' + action.type], opts, onEvent, logs, {
                step: 'flash'
              , actionType: action.type
              , partition: action.partition || null
              , artifactId: action.artifact || null
              })
          }, {concurrency: 1})
      }

      return Promise.map(context.manifest.actions, function(action) {
          var invocation = buildActionCommand(action, artifactsById, context.allowWrites)
          emit(onEvent, 'Running action ' + action.type)
          return runCommand(invocation.command, invocation.args, opts, onEvent, logs, {
              step: 'flash'
            , actionType: action.type
            , partition: action.partition || null
            , artifactId: action.artifact || null
            })
        }, {concurrency: 1})
    }

  , verify: function(context, onEvent) {
      emit(onEvent, 'Running post-flash verification checks')
      if (context.simulate) {
        return runCommand('echo', ['Simulated verify step'], opts, onEvent, logs, {
          step: 'verify'
        , actionType: 'verify-simulated'
        })
      }
      return runCommand('adb', ['devices'], opts, onEvent, logs, {
        step: 'verify'
      , actionType: 'adb-devices'
      })
    }

  , collectLogs: function() {
      return logs.slice()
    }
  }
}
