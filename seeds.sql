INSERT INTO `idp` (`id`, `name`, `domain`, `contactEmail`, `use_enhanced_reader_at`, `use_audiobooks_at`, `specialPricing`, `fromEmail`, `authMethod`, `sessionSharingAsRecipientInfo`, `entryPoint`, `logoutUrl`, `nameQualifier`, `idpcert`, `spcert`, `spkey`, `internalJWT`, `userInfoEndpoint`, `userInfoJWT`, `actionEndpoint`, `androidAppURL`, `iosAppURL`, `xapiOn`, `xapiEndpoint`, `xapiUsername`, `xapiPassword`, `xapiMaxBatchSize`, `readingSessionsOn`, `consentText`, `amplitudeSecretKey`, `maxMBPerBook`, `maxMBPerFile`, `googleAnalyticsCode`, `language`, `created_at`, `demo_expires_at`, `deviceLoginLimit`, `emailBGColor`, `emailInnerBGColor`, `emailLogoUrl`, `emailHideName`)
VALUES
	(21,'Toad Reader','read.test','admin@resourcingeducation.com','2022-02-17 00:00:00.000','2023-12-01 00:00:00.000',NULL,NULL,'SHIBBOLETH',NULL,'https://${SHIBBOLETH_IDENTITY_PROVIDER_HOST}/idp/profile/SAML2/Redirect/SSO',NULL,'','${SHIBBOLETH_IDENTITY_PROVIDER_SIGNING_CERTIFICATE}','${SAML_SERVICE_PROVIDER_EREADER_ENCRYPTION_CERTIFICATE}','-----BEGIN PRIVATE KEY-----\n${SAML_SERVICE_PROVIDER_EREADER_ENCRYPTION_PRIVATE_KEY}\n-----END PRIVATE KEY-----','kBaIFg8INge4FA9yGFvWCtFbBkp92VquL99ROV7j','http://callback:3000/api/ereader/userInfo','k4dtiTVYWZyLuATjoanY8c2c8TjGWnBs',NULL,'https://play.google.com/store/apps/details?id=com.toadreader.demo','https://itunes.apple.com/us/app/toad-reader/id1415099468?mt=8',0,NULL,NULL,NULL,NULL,1,NULL,NULL,40,15,NULL,NULL,'2017-05-01 00:00:00.000',NULL,0,NULL,NULL,'https://s3.amazonaws.com/cdn.toadreader.com/tenant_assets/logo-toadreader.png',1);

INSERT INTO `user` (`id`, `user_id_from_idp`, `idp_id`, `email`, `fullname`, `adminLevel`, `created_at`, `last_login_at`, `last_login_platform`)
VALUES
	(3, 'dev@toadreader.com', 21, 'dev@toadreader.com', 'Mr. Dev', 'ADMIN', '2020-10-14 16:47:50.859', '2024-02-29 21:32:48.023', 'Chrome 122.0.0 / Mac OS X 10.15.7');

INSERT INTO `user` (`id`, `user_id_from_idp`, `idp_id`, `email`, `fullname`, `adminLevel`, `created_at`, `last_login_at`, `last_login_platform`)
VALUES
	(-21, 'dummy@toadreader.com', 21, 'dummy@toadreader.com', 'No login', 'NONE', '2020-10-14 16:47:50.859', '2024-01-23 17:27:06.070', NULL);
