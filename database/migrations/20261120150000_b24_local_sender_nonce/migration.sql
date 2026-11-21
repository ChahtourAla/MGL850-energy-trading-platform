-- Conservative database-wide nonce reservation prevents collisions across
-- funding/allowance operations and across fixture sessions using the same sender.
CREATE TABLE "B24LocalSenderNonce" (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 "senderAddress" VARCHAR(42) NOT NULL CHECK ("senderAddress" ~ '^0x[0-9a-f]{40}$'),
 "senderNonce" BIGINT NOT NULL CHECK ("senderNonce">=0),
 kind VARCHAR(16) NOT NULL CHECK (kind IN ('FUNDING','ALLOWANCE')),
 "operationId" UUID NOT NULL,
 UNIQUE ("senderAddress","senderNonce"), UNIQUE (kind,"operationId")
);
INSERT INTO "B24LocalSenderNonce"("senderAddress","senderNonce",kind,"operationId") SELECT "senderAddress","senderNonce",'FUNDING',"operationId" FROM "B24FundingSubmission";
INSERT INTO "B24LocalSenderNonce"("senderAddress","senderNonce",kind,"operationId") SELECT r."buyerAddress",x."senderNonce",'ALLOWANCE',x."operationId" FROM "B24AllowanceSubmission" x JOIN "B24AuthorizationReservation" r ON r.id=x."reservationId";
CREATE FUNCTION "b24_reserve_local_sender_nonce"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE sender TEXT; operation_kind TEXT;
BEGIN
 IF TG_TABLE_NAME='B24FundingSubmission' THEN sender:=NEW."senderAddress";operation_kind:='FUNDING';
 ELSE SELECT "buyerAddress" INTO sender FROM public."B24AuthorizationReservation" WHERE id=NEW."reservationId";operation_kind:='ALLOWANCE'; END IF;
 INSERT INTO public."B24LocalSenderNonce"("senderAddress","senderNonce",kind,"operationId") VALUES(sender,NEW."senderNonce",operation_kind,NEW."operationId");
 RETURN NEW;
END $$;
CREATE TRIGGER "B24FundingSubmission_nonce" AFTER INSERT ON "B24FundingSubmission" FOR EACH ROW EXECUTE FUNCTION "b24_reserve_local_sender_nonce"();
CREATE TRIGGER "B24AllowanceSubmission_nonce" AFTER INSERT ON "B24AllowanceSubmission" FOR EACH ROW EXECUTE FUNCTION "b24_reserve_local_sender_nonce"();
CREATE TRIGGER "B24LocalSenderNonce_immutable" BEFORE UPDATE OR DELETE ON "B24LocalSenderNonce" FOR EACH ROW EXECUTE FUNCTION "b24_draft_journal_immutable"();
REVOKE ALL ON "B24LocalSenderNonce" FROM PUBLIC;
