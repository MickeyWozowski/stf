function TransactionError(result) {
  this.code = result.error
  this.message = result.error
  this.name = 'TransactionError'
  this.body = result.body || null
  this.status = null

  if (this.body && typeof this.body === 'object') {
    if (this.body.code) {
      this.code = this.body.code
    }
    if (this.body.message) {
      this.message = this.body.message
    }
    if (typeof this.body.status === 'number') {
      this.status = this.body.status
    }
  }

  Error.captureStackTrace(this, TransactionError)
}

TransactionError.prototype = Object.create(Error.prototype)
TransactionError.prototype.constructor = TransactionError

module.exports = TransactionError
