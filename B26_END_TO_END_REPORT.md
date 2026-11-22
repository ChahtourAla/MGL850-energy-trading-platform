# B26 end-to-end evidence

The tested closed-hour fixture used genuine B22 historical inputs and the existing B24/B25 local services. One allocation of 28 Wh at 90,750 micro-USD/kWh settled for exactly 2,541 TEUSD base units. The seller received the exact amount, the retry reused the original attempt, and an induced local reorganization changed the run from settled to needing reconciliation with zero currently verified paid.

Across 24 distinct intervals, 14 had no matches, nine produced non-authoritative drafts and were blocked, and one settled. Two separate worker processes exercised lease expiry and catch-up. The fixture generated and enrolled a synthetic wallet before snapshot finalization; it is not real-world consent or evidence of physical delivery.
