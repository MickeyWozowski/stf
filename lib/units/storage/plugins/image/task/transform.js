var gm = require('gm')
var Promise = require('bluebird')
var childProcess = require('child_process')

var gmMode = null
var gmFactory = gm

function detectGmMode() {
  if (gmMode !== null) {
    return gmMode
  }

  try {
    var gmCheck = childProcess.spawnSync('gm', ['version'], {
      stdio: 'ignore'
    })
    if (gmCheck && gmCheck.status === 0) {
      gmMode = 'gm'
      gmFactory = gm
      return gmMode
    }
  }
  catch (err) {
    // Ignore and try ImageMagick fallback.
  }

  try {
    var convertCheck = childProcess.spawnSync('convert', ['-version'], {
      stdio: 'ignore'
    })
    if (convertCheck && convertCheck.status === 0) {
      gmMode = 'imagemagick'
      gmFactory = gm.subClass({imageMagick: true})
      return gmMode
    }
  }
  catch (err) {
    // Ignore and fall back to passthrough mode.
  }

  gmMode = 'none'
  gmFactory = gm
  return gmMode
}

module.exports = function(stream, options) {
  options = options || {}

  // No transform requested: keep the original resource untouched.
  if (!options.gravity && !options.crop) {
    return Promise.resolve(stream)
  }

  // If graphics tooling is unavailable, degrade gracefully to source image.
  if (detectGmMode() === 'none') {
    return Promise.resolve(stream)
  }

  return new Promise(function(resolve, reject) {
    var transform = gmFactory(stream)

    if (options.gravity) {
      transform.gravity(options.gravity)
    }

    if (options.crop) {
      transform.geometry(options.crop.width, options.crop.height, '^')
      transform.crop(options.crop.width, options.crop.height, 0, 0)
    }

    transform.stream(function(err, stdout) {
      if (err) {
        reject(err)
      }
      else {
        resolve(stdout)
      }
    })
  })
}
