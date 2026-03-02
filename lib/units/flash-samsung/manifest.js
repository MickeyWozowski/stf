var fs = require('fs')
var path = require('path')
var crypto = require('crypto')

var Promise = require('bluebird')

var errors = require('./errors')

var readFile = Promise.promisify(fs.readFile)

var allowedActions = {
  'heimdall-detect': true
, 'heimdall-print-pit': true
, 'heimdall-flash': true
}

function normalizeString(value) {
  if (typeof value !== 'string') {
    return null
  }
  var normalized = value.trim()
  return normalized.length ? normalized : null
}

function upper(value) {
  var normalized = normalizeString(value)
  return normalized ? normalized.toUpperCase() : null
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function flashError(code, message, details) {
  return errors.create(code, message, details)
}

function validateTarget(target) {
  if (!isObject(target)) {
    throw flashError('INVALID_MANIFEST', 'Manifest must contain a target compatibility object')
  }

  var model = upper(target.model)
  var csc = upper(target.csc)
  var bootloaderMajor = upper(target.bootloaderMajor || target.bootloader || target.bootloaderFamily)

  if (!model || !csc || !bootloaderMajor) {
    throw flashError(
      'INVALID_MANIFEST',
      'Manifest target must include model, csc and bootloaderMajor'
    )
  }

  return {
      model: model
    , csc: csc
    , bootloaderMajor: bootloaderMajor
    }
}

function validateArtifacts(artifacts) {
  if (!Array.isArray(artifacts) || !artifacts.length) {
    throw flashError('INVALID_MANIFEST', 'Manifest must include at least one artifact')
  }

  var seen = Object.create(null)

  return artifacts.map(function(artifact, index) {
    if (!isObject(artifact)) {
      throw flashError('INVALID_MANIFEST', 'Manifest artifact entry must be an object', {
        index: index
      })
    }

    var id = normalizeString(artifact.id)
    var filePath = normalizeString(artifact.path)
    var sha256 = normalizeString(artifact.sha256)

    if (!id || !filePath || !sha256) {
      throw flashError('INVALID_MANIFEST', 'Each artifact must include id, path and sha256', {
        index: index
      })
    }

    if (!/^[a-fA-F0-9]{64}$/.test(sha256)) {
      throw flashError('INVALID_MANIFEST', 'Artifact checksum must be a 64-char sha256 hex string', {
        id: id
      })
    }

    if (seen[id]) {
      throw flashError('INVALID_MANIFEST', 'Artifact ids must be unique', {id: id})
    }
    seen[id] = true

    return {
        id: id
      , path: filePath
      , sha256: sha256.toLowerCase()
      }
  })
}

function validateActions(actions, artifactsById) {
  if (!Array.isArray(actions) || !actions.length) {
    throw flashError('INVALID_MANIFEST', 'Manifest must include at least one execution action')
  }

  return actions.map(function(action, index) {
    if (!isObject(action)) {
      throw flashError('INVALID_MANIFEST', 'Manifest action entry must be an object', {
        index: index
      })
    }

    var type = normalizeString(action.type)
    if (!type || !allowedActions[type]) {
      throw flashError('INVALID_MANIFEST', 'Unsupported action type in manifest', {
        type: type || null
      })
    }

    var normalized = {type: type}

    if (type === 'heimdall-flash') {
      var partition = upper(action.partition)
      var artifact = normalizeString(action.artifact)
      if (!partition || !artifact) {
        throw flashError(
          'INVALID_MANIFEST',
          'heimdall-flash action requires partition and artifact fields',
          {index: index}
        )
      }

      if (!/^[A-Z0-9_]+$/.test(partition)) {
        throw flashError('INVALID_MANIFEST', 'Invalid partition name in manifest action', {
          partition: partition
        })
      }

      if (!artifactsById[artifact]) {
        throw flashError('INVALID_MANIFEST', 'Flash action references unknown artifact', {
          artifact: artifact
        })
      }

      normalized.partition = partition
      normalized.artifact = artifact
    }

    return normalized
  })
}

function parseManifest(job) {
  var metadata = job.metadata || {}

  if (isObject(metadata.manifest)) {
    return Promise.resolve({
        manifest: metadata.manifest
      , sourcePath: null
      })
  }

  var manifestPath = normalizeString(metadata.manifestPath)
  if (!manifestPath) {
    throw flashError(
      'MANIFEST_REQUIRED',
      'Samsung execution requires a manifest in metadata.manifest or metadata.manifestPath'
    )
  }

  var resolvedPath = path.resolve(manifestPath)
  return readFile(resolvedPath, 'utf8')
    .catch(function(err) {
      if (err && err.code === 'ENOENT') {
        throw flashError('MANIFEST_NOT_FOUND', 'Manifest file was not found', {path: resolvedPath})
      }
      throw err
    })
    .then(function(content) {
      try {
        return {
            manifest: JSON.parse(content)
          , sourcePath: resolvedPath
          }
      }
      catch (err) {
        throw flashError('INVALID_MANIFEST', 'Manifest JSON parsing failed', {path: resolvedPath})
      }
    })
}

function normalizeManifest(manifest) {
  if (!isObject(manifest)) {
    throw flashError('INVALID_MANIFEST', 'Manifest payload must be a JSON object')
  }

  var artifacts = validateArtifacts(manifest.artifacts)
  var artifactsById = Object.create(null)
  artifacts.forEach(function(artifact) {
    artifactsById[artifact.id] = artifact
  })

  return {
      schemaVersion: normalizeString(manifest.schemaVersion) || '1'
    , target: validateTarget(manifest.target || manifest.deviceConstraints)
    , artifacts: artifacts
    , actions: validateActions(manifest.actions, artifactsById)
    }
}

function resolveArtifactPath(filePath, metadata, sourcePath) {
  if (path.isAbsolute(filePath)) {
    return filePath
  }

  var packageBase = normalizeString(metadata.packageBasePath)
  if (packageBase) {
    return path.resolve(packageBase, filePath)
  }

  if (sourcePath) {
    return path.resolve(path.dirname(sourcePath), filePath)
  }

  return path.resolve(process.cwd(), filePath)
}

function sha256File(filePath) {
  return new Promise(function(resolve, reject) {
    var hash = crypto.createHash('sha256')
    var stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', function(chunk) {
      hash.update(chunk)
    })
    stream.on('end', function() {
      resolve(hash.digest('hex'))
    })
  })
}

function validateChecksums(normalizedManifest, metadata, sourcePath) {
  return Promise.map(normalizedManifest.artifacts, function(artifact) {
      var resolvedPath = resolveArtifactPath(artifact.path, metadata || {}, sourcePath)
      return sha256File(resolvedPath)
        .catch(function(err) {
          if (err && err.code === 'ENOENT') {
            throw flashError('ARTIFACT_NOT_FOUND', 'Artifact file not found', {
              id: artifact.id
            , path: resolvedPath
            })
          }
          throw err
        })
        .then(function(checksum) {
          if (checksum !== artifact.sha256) {
            throw flashError('CHECKSUM_MISMATCH', 'Artifact checksum validation failed', {
              id: artifact.id
            , expected: artifact.sha256
            , actual: checksum
            })
          }

          return Object.assign({}, artifact, {
            resolvedPath: resolvedPath
          })
        })
    }, {concurrency: 1})
    .then(function(artifacts) {
      return Object.assign({}, normalizedManifest, {
        artifacts: artifacts
      })
    })
}

function extractBootloaderMajor(value) {
  var normalized = upper(value)
  if (!normalized) {
    return null
  }

  var major = /U\d+/.exec(normalized)
  if (major) {
    return major[0]
  }

  if (/^\d+$/.test(normalized)) {
    return 'U' + normalized
  }

  return normalized
}

function validateCompatibility(device, metadata, manifest) {
  var deviceInfo = isObject(metadata && metadata.deviceInfo) ? metadata.deviceInfo : {}

  var actualModel = upper(deviceInfo.model || device.model || device.product)
  var actualCsc = upper(deviceInfo.csc || metadata.deviceCsc)
  var actualBootloader = extractBootloaderMajor(deviceInfo.bootloader || metadata.deviceBootloader)

  if (!actualModel) {
    throw flashError('DEVICE_MODEL_UNKNOWN', 'Unable to determine target device model')
  }

  if (!actualCsc) {
    throw flashError(
      'DEVICE_METADATA_MISSING',
      'Missing device CSC in metadata.deviceInfo.csc (required for strict compatibility checks)'
    )
  }

  if (!actualBootloader) {
    throw flashError(
      'DEVICE_METADATA_MISSING',
      'Missing device bootloader in metadata.deviceInfo.bootloader (required for strict compatibility checks)'
    )
  }

  if (actualModel !== manifest.target.model) {
    throw flashError('MODEL_MISMATCH', 'Device model is incompatible with manifest target', {
      expected: manifest.target.model
    , actual: actualModel
    })
  }

  if (actualCsc !== manifest.target.csc) {
    throw flashError('CSC_MISMATCH', 'Device CSC is incompatible with manifest target', {
      expected: manifest.target.csc
    , actual: actualCsc
    })
  }

  var expectedBootloaderMajor = extractBootloaderMajor(manifest.target.bootloaderMajor)
  if (actualBootloader !== expectedBootloaderMajor) {
    throw flashError('BOOTLOADER_MISMATCH', 'Device bootloader major is incompatible with manifest target', {
      expected: expectedBootloaderMajor
    , actual: actualBootloader
    })
  }

  return {
      model: actualModel
    , csc: actualCsc
    , bootloaderMajor: actualBootloader
    }
}

module.exports = {
  parseManifest: parseManifest
, normalizeManifest: normalizeManifest
, validateChecksums: validateChecksums
, validateCompatibility: validateCompatibility
, extractBootloaderMajor: extractBootloaderMajor
}
