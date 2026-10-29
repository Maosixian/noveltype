'use strict';
const assert=require('node:assert/strict');
const version=require('../package.json').version;
assert.equal(process.argv[2],'v'+version,'Git tag must match package.json version');
console.log('Release tag matches v'+version);
