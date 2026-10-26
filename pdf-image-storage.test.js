'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { isMountPointMounted, resolvePdfImageStorage } = require('./pdf-image-storage');

function withTempDirectory(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdris-image-storage-test-'));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('uses ephemeral writable storage on Render when /var/data is not mounted', () => {
  withTempDirectory(root => {
    const result = resolvePdfImageStorage({
      env: { RENDER: 'true' },
      platform: 'linux',
      tempDir: root,
      mountInfo: '',
      logger: { warn() {} }
    });

    assert.equal(result.directory, path.join(root, 'bdris-autofill', 'pdf-images'));
    assert.equal(result.persistent, false);
    assert.ok(fs.existsSync(result.directory));
    assert.deepEqual(fs.readdirSync(result.directory), []);
  });
});

test('uses the mounted disk only when its mount is detected and writable', () => {
  withTempDirectory(root => {
    const mountPoint = path.join(root, 'persistent disk');
    fs.mkdirSync(mountPoint);
    const escapedMountPoint = mountPoint.replace(/ /g, '\\040');
    const mountInfo = `42 31 0:38 / ${escapedMountPoint} rw - ext4 /dev/vdb rw`;
    assert.equal(isMountPointMounted(mountInfo, mountPoint), true);

    const result = resolvePdfImageStorage({
      env: { RENDER: 'true' },
      platform: 'linux',
      tempDir: path.join(root, 'tmp'),
      mountPoint,
      mountInfo,
      logger: { warn() {} }
    });

    assert.equal(result.directory, path.join(mountPoint, 'pdf-images'));
    assert.equal(result.persistent, true);
    assert.deepEqual(fs.readdirSync(result.directory), []);
  });
});

test('falls back when the detected persistent mount cannot be written', () => {
  withTempDirectory(root => {
    const mountPoint = path.join(root, 'not-a-directory');
    fs.writeFileSync(mountPoint, 'occupied');
    const mountInfo = `42 31 0:38 / ${mountPoint} rw - ext4 /dev/vdb rw`;
    const warnings = [];
    const result = resolvePdfImageStorage({
      env: { RENDER: 'true' },
      platform: 'linux',
      tempDir: path.join(root, 'tmp'),
      mountPoint,
      mountInfo,
      logger: { warn(message) { warnings.push(message); } }
    });

    assert.equal(result.directory, path.join(root, 'tmp', 'bdris-autofill', 'pdf-images'));
    assert.equal(result.persistent, false);
    assert.equal(warnings.length, 1);
    assert.deepEqual(fs.readdirSync(result.directory), []);
  });
});

test('honors an explicit writable storage directory', () => {
  withTempDirectory(root => {
    const explicitDirectory = path.join(root, 'custom', 'images');
    const result = resolvePdfImageStorage({
      env: { PDF_IMAGE_STORAGE_DIR: explicitDirectory },
      projectDir: root,
      platform: 'win32',
      tempDir: path.join(root, 'tmp')
    });

    assert.equal(result.directory, explicitDirectory);
    assert.equal(result.persistent, false);
    assert.deepEqual(fs.readdirSync(result.directory), []);
  });
});

test('does not assume an explicit /var/data override is writable without a mount', () => {
  withTempDirectory(root => {
    const mountPoint = path.join(root, 'disk');
    const warnings = [];
    const result = resolvePdfImageStorage({
      env: { RENDER: 'true', PDF_IMAGE_STORAGE_DIR: path.join(mountPoint, 'pdf-images') },
      platform: 'linux',
      tempDir: root,
      mountPoint,
      mountInfo: '',
      logger: { warn(message) { warnings.push(message); } }
    });

    assert.equal(result.directory, path.join(root, 'bdris-autofill', 'pdf-images'));
    assert.equal(result.persistent, false);
    assert.equal(warnings.length, 1);
  });
});
