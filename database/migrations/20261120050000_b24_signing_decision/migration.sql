-- Offline-only signing decision. The b24_signer database role is a trusted verifier.
CREATE TABLE "B24SignedAuthorization" (
 "reservationId" UUID PRIMARY KEY REFERENCES "B24AuthorizationReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "operationId" UUID NOT NULL UNIQUE REFERENCES "B24SigningOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "settlementId" VARCHAR(66) NOT NULL, "buyerAddress" VARCHAR(42) NOT NULL,
 "signature" TEXT NOT NULL CHECK ("signature" ~ '^0x[0-9a-f]{130}$'),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
REVOKE ALL ON "B24SignedAuthorization" FROM PUBLIC;
CREATE FUNCTION "b24_sign_lock"(rid UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public."B24AuthorizationReservation"%ROWTYPE; p public."B24SpendingPolicy"%ROWTYPE; d public."B24Deployment"%ROWTYPE;
BEGIN
 IF session_user<>'b24_signer' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'signer not authorized' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public."B24AuthorizationReservation" WHERE id=rid;
 IF r.id IS NULL THEN RAISE EXCEPTION 'reservation not found'; END IF;
 SELECT * INTO p FROM public."B24SpendingPolicy" WHERE id=r."policyId" FOR UPDATE;
 SELECT * INTO d FROM public."B24Deployment" WHERE id=r."deploymentId" FOR UPDATE;
 IF p.status<>'ACTIVE' OR p."consentKind"<>'SIMULATED_TEST' OR d.status<>'TEST_FIXTURE' OR d."chainId"<>31337 OR p."deploymentId"<>d.id OR p."buyerAddress"<>r."buyerAddress" OR p."tokenAddress"<>d."tokenAddress" OR clock_timestamp()<p."effectiveAt" OR clock_timestamp()>=p."expiresAt" OR r.deadline>p."expiresAt" OR r.deadline<=clock_timestamp()+interval '60 seconds' THEN RAISE EXCEPTION 'signing authorization invalid'; END IF;
 RETURN to_jsonb(r);
END $$;
CREATE FUNCTION "b24_sign_record"(rid UUID, oid UUID, sig TEXT, digest TEXT) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public."B24AuthorizationReservation"%ROWTYPE; existing public."B24SignedAuthorization"%ROWTYPE;
BEGIN
 IF session_user<>'b24_signer' THEN RAISE EXCEPTION 'signer not authorized' USING ERRCODE='42501'; END IF;
 PERFORM public."b24_sign_lock"(rid);
 SELECT * INTO r FROM public."B24AuthorizationReservation" WHERE id=rid;
 IF digest<>r."settlementId" OR sig !~ '^0x[0-9a-f]{130}$' THEN RAISE EXCEPTION 'invalid signing result'; END IF;
 SELECT * INTO existing FROM public."B24SignedAuthorization" WHERE "reservationId"=rid;
 IF existing."reservationId" IS NOT NULL THEN
  IF existing."settlementId"<>digest THEN RAISE EXCEPTION 'conflicting signing result'; END IF;
  RETURN existing."signature";
 END IF;
 INSERT INTO public."B24SigningOperation"(id,"reservationId","idempotencyKey",principal) VALUES(oid,rid,rid::text,session_user);
 INSERT INTO public."B24SignedAuthorization"("reservationId","operationId","settlementId","buyerAddress",signature) VALUES(rid,oid,digest,r."buyerAddress",sig);
 RETURN sig;
END $$;
CREATE FUNCTION "b24_signed_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'signed authorization is immutable'; END $$;
CREATE TRIGGER "B24SignedAuthorization_immutable" BEFORE UPDATE OR DELETE ON "B24SignedAuthorization" FOR EACH ROW EXECUTE FUNCTION "b24_signed_immutable"();
REVOKE ALL ON FUNCTION "b24_sign_lock"(UUID), "b24_sign_record"(UUID,UUID,TEXT,TEXT) FROM PUBLIC;
CREATE FUNCTION "b24_sign_lookup"(rid UUID) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result TEXT;
BEGIN
 IF session_user<>'b24_signer' THEN RAISE EXCEPTION 'signer not authorized' USING ERRCODE='42501'; END IF;
 PERFORM public."b24_sign_lock"(rid);
 SELECT signature INTO result FROM public."B24SignedAuthorization" WHERE "reservationId"=rid;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION "b24_sign_lookup"(UUID) FROM PUBLIC;
