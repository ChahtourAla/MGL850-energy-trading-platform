-- Run only by the disposable schema owner after a non-owner b24_signer LOGIN exists.
GRANT USAGE ON SCHEMA public,b22_guard TO b24_signer;
GRANT SELECT ON b22_guard.marker TO b24_signer;
GRANT EXECUTE ON FUNCTION "b24_sign_lock"(UUID), "b24_sign_lookup"(UUID), "b24_sign_record"(UUID,UUID,TEXT,TEXT) TO b24_signer;
