'use strict';

function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}
function make(tag) {
  const p = `[${tag}]`;
  return {
    info: (...a) => console.log(ts(), p, ...a),
    warn: (...a) => console.warn(ts(), p, 'WARN', ...a),
    err: (...a) => console.error(ts(), p, 'ERROR', ...a),
  };
}
module.exports = { make };
