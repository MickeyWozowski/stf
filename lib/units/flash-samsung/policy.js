var errors = require('./errors')

function toString(value) {
  if (typeof value !== 'string') {
    return null
  }
  var normalized = value.trim()
  return normalized.length ? normalized : null
}

function toList(value) {
  if (!value) {
    return []
  }
  if (Array.isArray(value)) {
    return value.map(toString).filter(Boolean)
  }
  return String(value)
    .split(',')
    .map(function(item) {
      return toString(item)
    })
    .filter(Boolean)
}

function toBool(value, defaultValue) {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value !== 0
  }
  if (typeof value === 'string') {
    var normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].indexOf(normalized) !== -1) {
      return true
    }
    if (['0', 'false', 'no', 'off'].indexOf(normalized) !== -1) {
      return false
    }
  }
  return !!defaultValue
}

function flashError(code, message, details) {
  return errors.create(code, message, details)
}

function isDevEnvironment(profile) {
  var normalized = toString(profile)
  if (!normalized) {
    return false
  }
  normalized = normalized.toLowerCase()
  return ['dev', 'development', 'local', 'test'].indexOf(normalized) !== -1
}

function evaluateMacDevLocal(job, device, actor, options) {
  var opts = options || {}
  var metadata = job.metadata || {}
  var confirmationPhrase = opts.confirmationPhrase || 'I_UNDERSTAND_THIS_WILL_FLASH'
  var allowMacDevLocal = toBool(opts.allowMacDevLocal, false)
  var allowWrites = toBool(opts.allowWrites, false)
  var environmentProfile = opts.environmentProfile || process.env.STF_FLASH_SAMSUNG_ENV || process.env.NODE_ENV
  var allowedSerials = toList(opts.allowedSerials || process.env.STF_FLASH_SAMSUNG_ALLOWED_SERIALS)
  var allowedPackages = toList(opts.allowedPackagePrefixes || process.env.STF_FLASH_SAMSUNG_ALLOWED_PACKAGE_PREFIXES)
  var destructiveConfirmation = toString(metadata.destructiveConfirmation)

  if (!allowMacDevLocal) {
    throw flashError(
      'MAC_DEV_LOCAL_DISABLED',
      'mac-dev-local backend is disabled by policy. Set STF_FLASH_SAMSUNG_ENABLE_MAC_DEV_LOCAL=true to enable.'
    )
  }

  if (!isDevEnvironment(environmentProfile)) {
    throw flashError(
      'MAC_DEV_LOCAL_POLICY_REJECTED',
      'mac-dev-local backend is blocked outside development environments',
      {environmentProfile: environmentProfile || null}
    )
  }

  if (allowedSerials.length && allowedSerials.indexOf(device.serial) === -1) {
    throw flashError('SERIAL_NOT_ALLOWLISTED', 'Target device serial is not in mac-dev-local allowlist')
  }

  if (allowedPackages.length) {
    var packageAllowed = allowedPackages.some(function(prefix) {
      return String(job.packageRef || '').indexOf(prefix) === 0
    })
    if (!packageAllowed) {
      throw flashError('PACKAGE_NOT_ALLOWLISTED', 'Package reference is not in mac-dev-local allowlist')
    }
  }

  if (!destructiveConfirmation || destructiveConfirmation !== confirmationPhrase) {
    throw flashError(
      'DESTRUCTIVE_CONFIRMATION_REQUIRED',
      'Missing required destructive confirmation marker for mac-dev-local execution'
    )
  }

  return {
      backend: 'mac-dev-local'
    , auditMarker: 'DEV_ONLY_BACKEND'
    , warnings: [
        'WARNING: Running development backend on macOS. This path is not production validated.'
      ]
    , allowWrites: allowWrites
    , environmentProfile: environmentProfile || 'unknown'
    }
}

module.exports = {
  evaluate: function(job, device, actor, options) {
    var backend = job.executionBackend || (options && options.executionBackend) || 'mac-dev-local'

    if (backend !== 'mac-dev-local') {
      throw flashError(
        'BACKEND_NOT_SUPPORTED',
        'Requested execution backend is not available in this validation cycle',
        {backend: backend}
      )
    }

    return evaluateMacDevLocal(job, device, actor, options)
  }
}
