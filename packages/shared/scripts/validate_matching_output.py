
import json
import math
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource


# --------------------------------------------------
# 1. Locate shared schemas and fixtures
# --------------------------------------------------

shared_dir = Path(__file__).resolve().parents[1]
schema_dir = shared_dir / "schemas"
fixture_dir = shared_dir / "fixtures"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


# --------------------------------------------------
# 2. Register all required JSON Schemas
# --------------------------------------------------

schema_names = [
    "common.schema.json",
    "hourly-energy-record.schema.json",
    "matching-config.schema.json",
    "matching-input.schema.json",
    "match-result.schema.json",
    "matching-output.schema.json",
]

registry = Registry()

for name in schema_names:
    schema = load_json(schema_dir / name)

    Draft202012Validator.check_schema(schema)

    registry = registry.with_resource(
        schema["$id"],
        Resource.from_contents(schema)
    )


def make_validator(name):
    return Draft202012Validator(
        load_json(schema_dir / name),
        registry=registry,
        format_checker=FormatChecker()
    )


input_validator = make_validator(
    "matching-input.schema.json"
)

output_validator = make_validator(
    "matching-output.schema.json"
)


def check_schema(validator, data, label):
    errors = list(validator.iter_errors(data))

    if errors:
        raise ValueError(
            f"Invalid {label}: {errors[0].message}"
        )


def clamp(value):
    return max(0.0, min(1.0, value))


# --------------------------------------------------
# 3. Validate matching output against input
# --------------------------------------------------

def validate_matching_output(matching_output, matching_input):

    check_schema(
        input_validator,
        matching_input,
        "matching input"
    )

    check_schema(
        output_validator,
        matching_output,
        "matching output"
    )

    # Check common metadata.
    for field in [
        "schemaVersion",
        "snapshotId",
        "timeSlot",
        "algorithmVersion",
    ]:
        if matching_output[field] != matching_input[field]:
            raise ValueError(
                f"Incorrect output {field}"
            )

    weights = matching_input["scoringWeights"]

    if not math.isclose(
        sum(weights.values()),
        1.0,
        rel_tol=0,
        abs_tol=1e-9
    ):
        raise ValueError("Invalid scoring weights")

    maximum_distance = matching_input["maximumDistanceKm"]

    # Get all buyers and sellers.
    buyers = {}
    sellers = {}

    for user in matching_input["users"]:
        if user["timeSlot"] != matching_input["timeSlot"]:
            raise ValueError("Inconsistent input timeSlot")

        if user["marketRole"] == "BUYER":
            if user["userId"] in buyers:
                raise ValueError("Duplicate input buyer")
            buyers[user["userId"]] = user

        elif user["marketRole"] == "SELLER":
            if user["userId"] in sellers:
                raise ValueError("Duplicate input seller")
            sellers[user["userId"]] = user

    # Remaining energy prevents double-selling.
    remaining_energy = {
        seller_id: seller["availableEnergyWh"]
        for seller_id, seller in sellers.items()
    }

    matched_buyers = set()
    match_ids = set()

    # Validate every selected match.
    for match in matching_output["matches"]:

        buyer_id = match["buyerId"]
        seller_id = match["sellerId"]
        match_id = match["matchId"]

        if match_id in match_ids:
            raise ValueError("Duplicate matchId")

        match_ids.add(match_id)

        if buyer_id not in buyers:
            raise ValueError("Unknown or invalid buyer")

        if seller_id not in sellers:
            raise ValueError("Unknown or invalid seller")

        if buyer_id == seller_id:
            raise ValueError("Self-matching is not allowed")

        if buyer_id in matched_buyers:
            raise ValueError("Buyer matched more than once")

        matched_buyers.add(buyer_id)

        buyer = buyers[buyer_id]
        seller = sellers[seller_id]

        if match["algorithmVersion"] != matching_input["algorithmVersion"]:
            raise ValueError("Incorrect match algorithmVersion")

        if match["timeSlot"] != matching_input["timeSlot"]:
            raise ValueError("Incorrect match timeSlot")

        if match["buyerWallet"].lower() != buyer["evmAddress"].lower():
            raise ValueError("Incorrect buyer wallet")

        if match["sellerWallet"].lower() != seller["evmAddress"].lower():
            raise ValueError("Incorrect seller wallet")

        quantity = match["quantityWh"]

        # Version 1: one buyer is fully served
        # by one seller.
        if quantity != buyer["requiredEnergyWh"]:
            raise ValueError("Incorrect matched quantity")

        available = remaining_energy[seller_id]

        if quantity > available:
            raise ValueError("Seller energy overallocated")

        price = match["unitPriceMicrousdPerKwh"]

        if price != seller["askPriceMicrousdPerKwh"]:
            raise ValueError("Incorrect agreed unit price")

        if price > buyer["maxPriceMicrousdPerKwh"]:
            raise ValueError("Seller price exceeds buyer limit")

        if (
            buyer["preferredEnergyType"] != "ANY"
            and buyer["preferredEnergyType"] != seller["energyType"]
        ):
            raise ValueError("Incompatible energy type")

        if match["sellerEnergyType"] != seller["energyType"]:
            raise ValueError("Incorrect seller energy type")

        # The Solidity contract uses integer division.
        expected_total = quantity * price // 1000

        if expected_total <= 0:
            raise ValueError("Payment amount must be positive")

        if match["totalAmountMicrousd"] != expected_total:
            raise ValueError("Incorrect total payment amount")

        # Calculate distance using the original
        # user coordinates.
        distance = math.hypot(
            buyer["xKm"] - seller["xKm"],
            buyer["yKm"] - seller["yKm"]
        )

        if distance > maximum_distance:
            raise ValueError("Distance exceeds maximum")

        if not math.isclose(
            match["distanceKm"],
            distance,
            rel_tol=0,
            abs_tol=1e-9
        ):
            raise ValueError("Incorrect distance")

        # Verify the specified V1 scoring formula.
        quantity_score = clamp(quantity / available)

        price_score = clamp(
            1 - price / buyer["maxPriceMicrousdPerKwh"]
        )

        distance_score = clamp(
            1 - distance / maximum_distance
        )

        reputation_score = clamp(
            seller["reputation"] / 100
        )

        expected_score = (
            weights["quantity"] * quantity_score
            + weights["price"] * price_score
            + weights["distance"] * distance_score
            + weights["reputation"] * reputation_score
        )

        if not math.isclose(
            match["score"],
            expected_score,
            rel_tol=0,
            abs_tol=1e-9
        ):
            raise ValueError("Incorrect matching score")

        # Remove allocated energy before checking
        # the next match.
        remaining_energy[seller_id] -= quantity

    # --------------------------------------------------
    # 4. Validate unmatched buyers
    # --------------------------------------------------

    unmatched_buyers = set(
        matching_output["unmatchedBuyerIds"]
    )

    if not unmatched_buyers.issubset(set(buyers)):
        raise ValueError("Unknown unmatched buyer")

    if matched_buyers & unmatched_buyers:
        raise ValueError(
            "Buyer is both matched and unmatched"
        )

    if matched_buyers | unmatched_buyers != set(buyers):
        raise ValueError(
            "Some buyers are missing from the result"
        )


# --------------------------------------------------
# 5. Load example fixtures
# --------------------------------------------------

matching_input = load_json(
    fixture_dir / "matching-input.sample.json"
)

matching_output = load_json(
    fixture_dir / "matching-output.sample.json"
)


# --------------------------------------------------
# 6. Validate the successful matching example
# --------------------------------------------------

validate_matching_output(
    matching_output,
    matching_input
)

print("PASS: MatchResult schema is valid")
print("PASS: MatchingOutput schema is valid")
print("PASS: output metadata agrees with input")
print("PASS: buyer and seller identifiers are valid")
print("PASS: energy and payment calculations are correct")
print("PASS: distance and scoring calculations are correct")
print("PASS: all buyers are accounted for")


# --------------------------------------------------
# 7. Helper to test invalid results
# --------------------------------------------------

def expect_rejection(test_output, label, test_input=None):
    if test_input is None:
        test_input = matching_input

    try:
        validate_matching_output(test_output, test_input)
    except ValueError:
        print(f"PASS: rejected {label}")
    else:
        raise AssertionError(
            f"Invalid matching output accepted: {label}"
        )


# Invalid case 1: wrong total payment
bad = deepcopy(matching_output)
bad["matches"][0]["totalAmountMicrousd"] = 999999

expect_rejection(bad, "incorrect payment amount")


# Invalid case 2: wrong buyer wallet
bad = deepcopy(matching_output)
bad["matches"][0]["buyerWallet"] = (
    "0x9999999999999999999999999999999999999999"
)

expect_rejection(bad, "incorrect buyer wallet")


# Invalid case 3: unknown seller
bad = deepcopy(matching_output)
bad["matches"][0]["sellerId"] = (
    "99999999-9999-4999-8999-999999999999"
)

expect_rejection(bad, "unknown seller")


# Invalid case 4: incorrect match score
bad = deepcopy(matching_output)
bad["matches"][0]["score"] = 0.99

expect_rejection(bad, "incorrect score")


# Invalid case 5: incorrect matched quantity
bad = deepcopy(matching_output)
bad["matches"][0]["quantityWh"] = 5000

expect_rejection(bad, "incorrect matched quantity")


# Invalid case 6: incorrect algorithm version
bad = deepcopy(matching_output)
bad["algorithmVersion"] = "2.0.0"

expect_rejection(bad, "incorrect algorithm version")


# Invalid case 7: buyer both matched and unmatched
bad = deepcopy(matching_output)
bad["unmatchedBuyerIds"].append(
    matching_input["users"][1]["userId"]
)

expect_rejection(bad, "buyer both matched and unmatched")


# Invalid case 8: duplicate buyer in the matches
bad = deepcopy(matching_output)
extra_match = deepcopy(bad["matches"][0])
extra_match["matchId"] = (
    "77777777-7777-4777-8777-777777777777"
)

bad["matches"].append(extra_match)

expect_rejection(bad, "duplicate buyer match")


# --------------------------------------------------
# 8. Test a valid no-match result
# --------------------------------------------------

no_match_output = deepcopy(matching_output)

no_match_output["matches"] = []

no_match_output["unmatchedBuyerIds"] = [
    user["userId"]
    for user in matching_input["users"]
    if user["marketRole"] == "BUYER"
]

validate_matching_output(
    no_match_output,
    matching_input
)

print("PASS: no-match output is valid")


# --------------------------------------------------
# 9. Final result
# --------------------------------------------------

print("\nPASS: Matching output validation complete")
