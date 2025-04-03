# Installation (dev staging setup using docker compose)

1. Copy .env-example to .env (this should work without modification)
2. Populate other .env files from the other repos:
   - `.env.callback` from [ereader-callback](biblemesh/ereader-callback) (`.env.dist`)
   - `.env.shibboleth` from [shibboleth](biblemesh/shibboleth) (`shibboleth-common/.env.dist`)
3. Copy the secret file `caddy-pki.tar.gz` to the `secrets` directory, or create a new one containing the following files:
   (the `caddy` service can create these files for you) - `authorities/local/root.key` - `authorities/local/root.crt` - `authorities/local/intermediate.crt` - `authorities/local/intermediate.key`
4. Build and start the caddy service: `docker compose up --build -d caddy`
5. Build all other services: `docker compose build`
6. Start the services: `docker compose up` (note that the caddy service must be started first, otherwise you may
   receive an error from Docker about the network)

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
