#!/bin/sh

set -e

ENVSUBST="envsubst -no-unset -no-empty"

INPUT="./seeds.sql"
OUTPUT="./output/02-initdata.sql"
env

if [ -f "$OUTPUT" ]; then
    echo "Output file already exists. Skipping."
    exit 0
fi

export SAML_SERVICE_PROVIDER_EREADER_ENCRYPTION_CERTIFICATE=$(cat sp-read-encrypt.crt | sed --regexp-extended '/\-+(BEGIN|END) CERTIFICATE\-+[[:space:]]*/d' | sed ':a;N;$!ba;s/\n/\\n/g')
export SAML_SERVICE_PROVIDER_EREADER_ENCRYPTION_PRIVATE_KEY=$(cat sp-read-encrypt.key | sed --regexp-extended '/\-+(BEGIN|END) PRIVATE KEY\-+[[:space:]]*/d' | sed ':a;N;$!ba;s/\n/\\n/g')
export SHIBBOLETH_IDENTITY_PROVIDER_SIGNING_CERTIFICATE=$(cat idp-signing.crt | sed --regexp-extended '/\-+(BEGIN|END) CERTIFICATE\-+[[:space:]]*/d' | sed ':a;N;$!ba;s/\n/\\n/g')

$ENVSUBST -i "$INPUT" -o "$OUTPUT"
