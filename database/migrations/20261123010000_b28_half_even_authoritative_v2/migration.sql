-- B28.1: additive, version-aware exact-payment / half-even allocation check.
-- Leaves original B22 and B24/B25 authorization and settlement paths unchanged.
-- Approval of this migration is separate from approval of any market data write.
-- The raw division remainder is stored for audit, even when the rounded amount
-- differs from the legacy floor. No prior row is modified.

ALTER TABLE "V2Allocation" DROP CONSTRAINT "V2Allocation_terms_check";
ALTER TABLE "V2Allocation" ADD CONSTRAINT "V2Allocation_terms_check" CHECK (
    "buyerId" <> "sellerId"
    AND "buyerAddress" <> "sellerAddress"
    AND "quantityWh" > 0
    AND "unitPriceMicrousdPerKwh" > 0
    AND "amountBaseUnits" >= 0
    AND "remainder" BETWEEN 0 AND 999
    AND (
        CASE
        WHEN "pricingVersion" = 'b28-teusd-half-even-1' THEN
            "remainder"::numeric = mod("quantityWh"::numeric * "unitPriceMicrousdPerKwh"::numeric,1000)
            AND "amountBaseUnits"::numeric = floor("quantityWh"::numeric * "unitPriceMicrousdPerKwh"::numeric / 1000)
                + CASE
                    WHEN mod("quantityWh"::numeric * "unitPriceMicrousdPerKwh"::numeric,1000) > 500 THEN 1
                    WHEN mod("quantityWh"::numeric * "unitPriceMicrousdPerKwh"::numeric,1000) = 500
                         AND mod(floor("quantityWh"::numeric * "unitPriceMicrousdPerKwh"::numeric / 1000),2)=1 THEN 1
                    ELSE 0 END
        ELSE
            "quantityWh"::numeric * "unitPriceMicrousdPerKwh"::numeric =
                "amountBaseUnits"::numeric * 1000 + "remainder"::numeric
        END
    )
);
-- B24's remainder=0 and local-only restrictions remain intact.
