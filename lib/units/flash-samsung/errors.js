var util = require('util')

function FlashError(code, message, details) {
  Error.call(this)
  this.name = 'FlashError'
  this.code = code || 'FLASH_ERROR'
  this.message = message || 'Samsung flash worker error'
  this.details = details || null
  Error.captureStackTrace(this, FlashError)
}

util.inherits(FlashError, Error)

module.exports = {
  FlashError: FlashError
, create: function(code, message, details) {
    return new FlashError(code, message, details)
  }
}
