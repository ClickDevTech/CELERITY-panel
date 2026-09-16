'use strict';

// Quote a value as one POSIX shell argument.
function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

module.exports = { shellQuote };
