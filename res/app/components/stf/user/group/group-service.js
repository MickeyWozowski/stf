var Promise = require('bluebird')

module.exports = function GroupServiceFactory(
  socket
, TransactionService
, TransactionError
) {
  function debugLog(level, message, details) {
    var logger = console && console[level] ? console[level] : console.log
    if (typeof details !== 'undefined') {
      logger.call(console, '[STF-DBG][GroupService] ' + message, details)
    }
    else {
      logger.call(console, '[STF-DBG][GroupService] ' + message)
    }
  }

  var groupService = {
  }

  groupService.invite = function(device) {
    debugLog('info', 'invite called', {
      serial: device && device.serial
    , usable: device && device.usable
    , using: device && device.using
    , channel: device && device.channel
    })

    if (!device.usable) {
      debugLog('warn', 'invite aborted: device not usable', {
        serial: device && device.serial
      , usable: device && device.usable
      })
      return Promise.reject(new Error('Device is not usable'))
    }

    var tx = TransactionService.create(device)
    debugLog('info', 'invite transaction created', {
      serial: device && device.serial
    , txChannel: tx && tx.channel
    })
    socket.emit('group.invite', device.channel, tx.channel, {
      requirements: {
        serial: {
          value: device.serial
        , match: 'exact'
        }
      }
    })
    return tx.promise
      .then(function(result) {
        debugLog('info', 'invite transaction resolved', {
          serial: result && result.device && result.device.serial
        , using: result && result.device && result.device.using
        , owner: result && result.device && result.device.owner
        })
        return result.device
      })
      .catch(TransactionError, function() {
        debugLog('warn', 'invite transaction rejected with TransactionError', {
          serial: device && device.serial
        })
        throw new Error('Device refused to join the group')
      })
      .catch(function(err) {
        debugLog('error', 'invite transaction rejected', {
          serial: device && device.serial
        , message: err && err.message
        })
        throw err
      })
  }

  groupService.kick = function(device, force) {
    if (!force && !device.usable) {
      return Promise.reject(new Error('Device is not usable'))
    }

    var tx = TransactionService.create(device)
    socket.emit('group.kick', device.channel, tx.channel, {
      requirements: {
        serial: {
          value: device.serial
        , match: 'exact'
        }
      }
    })
    return tx.promise
      .then(function(result) {
        return result.device
      })
      .catch(TransactionError, function() {
        throw new Error('Device refused to join the group')
      })
  }

  return groupService
}
