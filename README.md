# Installation (dev staging setup using docker compose)

1. Copy .env-example to .env (this should work without modification)
1. Populate other .env files from the other repos:
   - `.env.callback` from [ereader-callback](biblemesh/ereader-callback) (`.env.dist`)
   - `.env.shibboleth` from [shibboleth](biblemesh/shibboleth) (`shibboleth-common/.env.dist`)
1. Build and start the caddy service: `docker compose up -d caddy`
1. Pull other services: `docker compose pull`
1. Build and start the services: `docker compose up` (note that the caddy service must be started first, otherwise you may
   receive an error from Docker about the network)

# Proxy auto-configuration file

A file called `proxy.pac` is generated and hosted by Caddy, to simplify connecting to the services by domain name. To use it (assuming your Caddy service is accessible on `localhost`, set your proxy autoconfiguration URL to:

    https://localhost:3128/proxy.pac

You will also need to add the `rootCA.crt` root certificate to your OS or browser's certificates manager. This certificate is available inside the `biblemesh/shibboleth-common:1.0.0-dev` Docker image, after this has been built.

# Installation (standalone server, dev mode)

1. `nvm use`
1. `npm install`
1. Copy .env-example.standalone to .env and update appropriately (DEV_NETWORK_IP for sure)
1. Create a MySQL database using `db_structure.sql` and `seeds.sql`
1. Change auto-increment for the `book` table to be some large number so as to not conflict with other devs (since the same aws s3 bucket is used)
1. Complete AWS setup (needed for import of epub or audiobook + testing emails)

(Unless emails need to be tested, you may simply log in with dev@toadreader.com, grabbing the login code from the logs.)

# Development

`npm start`

# Updating Staging

`npm run push-to-aws`

# Demo

[toadreader.com/demo](https://toadreader.com/demo/)

# License

[AGPL-3.0](https://opensource.org/licenses/AGPL-3.0) ([summary](<https://tldrlegal.com/license/gnu-affero-general-public-license-v3-(agpl-3.0)>))
