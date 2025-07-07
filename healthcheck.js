#!/usr/bin/env node

const http = require('http');

http
  .get(`http://localhost:${process.env.PORT || 8080}/Shibboleth.sso/Metadata`,
    { host: `${process.env.DEFAULT_IDP_DOMAIN || 'localhost'}:${process.env.PORT || 8080}` },
    (res) => {
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
