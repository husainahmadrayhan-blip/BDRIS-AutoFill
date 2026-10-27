'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function isMountPointMounted(mountInfo, mountPoint) {
  const expected = path.resolve(mountPoint);
  return String(mountInfo || '').split(/\r?\n/).some(line => {
    const fields = line.split(' - ', 1)[0].split(' ');
    const actual = fields[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    return actual && path.resolve(actual) === expected;
  });
}

function hasMountedDisk({ fsModule, platform, mountPoint, mountInfoPath, mountInfo }) {
  if (platform !== 'linux') return false;
  try {
    const contents = mountInfo ?? fsModule.readFileSync(mountInfoPath, 'utf8');
    return isMountPointMounted(contents, mountPoint);
  } catch {
    return false;
  }
}

function ensureWritableDirectory(directory, fsModule, cryptoModule) {
  fsModule.mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, `.write-check-${process.pid}-${cryptoModule.randomBytes(8).toString('hex')}`);
  fsModule.writeFileSync(probe, 'ok', { flag: 'wx' });
  fsModule.unlinkSync(probe);
}

function resolvePdfImageStorage({
  env = process.env,
  projectDir = __dirname,
  platform = os.platform(),
  tempDir = os.tmpdir(),
  fsModule = fs,
  cryptoModule = crypto,
  logger = console,
  mountPoint = '/var/data',
  mountInfoPath = '/proc/self/mountinfo',
  mountInfo
} = {}) {
  const render = String(env.RENDER || '').toLowerCase() === 'true';
  const explicitDirectory = String(env.PDF_IMAGE_STORAGE_DIR || '').trim();
  const localDirectory = path.join(projectDir, 'data', 'pdf-images');
  const temporaryDirectory = path.join(tempDir, 'bdris-autofill', 'pdf-images');
  const resolvedMountPoint = path.resolve(mountPoint);
  const diskMounted = render && hasMountedDisk({
    fsModule, platform, mountPoint, mountInfoPath, mountInfo
  });
  const useEphemeralDirectory = () => {
    ensureWritableDirectory(temporaryDirectory, fsModule, cryptoModule);
    return { directory: temporaryDirectory, persistent: false };
  };

  if (explicitDirectory) {
    const directory = path.resolve(explicitDirectory);
    const isInsideMount = directory === resolvedMountPoint || directory.startsWith(`${resolvedMountPoint}${path.sep}`);
    if (render && isInsideMount) {
      if (diskMounted) {
        try {
          ensureWritableDirectory(directory, fsModule, cryptoModule);
          return { directory, persistent: true };
        } catch (error) {
          logger.warn(`[MAKE PDF IMAGE] Configured persistent disk path is not writable (${error.code || error.name}); using ephemeral storage.`);
        }
      } else {
        logger.warn('[MAKE PDF IMAGE] Configured /var/data path has no detected persistent disk mount; using ephemeral storage.');
      }
      return useEphemeralDirectory();
    }
    ensureWritableDirectory(directory, fsModule, cryptoModule);
    if (render) logger.warn('[MAKE PDF IMAGE] PDF_IMAGE_STORAGE_DIR is outside the verified /var/data mount; filesystem storage is ephemeral. Use Neon database storage for durable image binaries.');
    return { directory, persistent: false };
  }

  if (!render) {
    ensureWritableDirectory(localDirectory, fsModule, cryptoModule);
    return { directory: localDirectory, persistent: false };
  }

  if (diskMounted) {
    const directory = path.join(mountPoint, 'pdf-images');
    try {
      ensureWritableDirectory(directory, fsModule, cryptoModule);
      return { directory, persistent: true };
    } catch (error) {
      logger.warn(`[MAKE PDF IMAGE] Persistent disk is mounted but not writable (${error.code || error.name}); using ephemeral storage.`);
    }
  } else {
    logger.warn('[MAKE PDF IMAGE] No /var/data persistent disk mount detected; using ephemeral storage.');
  }

  return useEphemeralDirectory();
}

module.exports = { isMountPointMounted, resolvePdfImageStorage };
