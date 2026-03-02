var errors = require('../errors')
var macDevLocal = require('./mac-dev-local')

function notImplemented(backend) {
  return function() {
    throw errors.create(
      'BACKEND_NOT_IMPLEMENTED',
      'Samsung flash backend is not implemented',
      {backend: backend}
    )
  }
}

module.exports = {
  createExecutor: function(backend, options) {
    var name = backend || 'mac-dev-local'

    if (name === 'mac-dev-local') {
      return macDevLocal(options || {})
    }

    return {
        prepare: notImplemented(name)
      , flash: notImplemented(name)
      , verify: notImplemented(name)
      , collectLogs: function() {
          return []
        }
      }
  }
}
