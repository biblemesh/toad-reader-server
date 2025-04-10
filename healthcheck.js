#!/usr/bin/env node

const http = require('http');

http
  .get('http://127.0.0.1:8080/Shibboleth.sso/Metadata', (res) => {
    console.log('statusCode', res.statusCode);
    if (res.statusCode === 200) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  })
  .on('error', (err) => {
    console.log('error', err);
    process.exit(1);
  });
