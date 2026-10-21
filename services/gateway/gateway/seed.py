"""Seed data for the fictional demo company. Values are fixed so every scenario is reproducible."""

import re

COMPANY = "Lumen Labs"
POLICY_VERSION = "2026-10-20.1"

EMPLOYEES = {
    "emp_maya": {"name": "Maya Chen", "department": "Engineering", "manager_id": "emp_priya"},
    "emp_dev": {"name": "Dev Patel", "department": "Sales", "manager_id": "emp_jordan"},
    "emp_priya": {"name": "Priya Rao", "department": "Engineering", "manager_id": "emp_sam"},
    "emp_jordan": {"name": "Jordan Lee", "department": "Sales", "manager_id": "emp_sam"},
    "emp_sam": {"name": "Sam Ortiz", "department": "Finance", "manager_id": None},
}

CALENDAR = {
    "emp_maya": [
        {"title": "Acme customer meeting", "date": "2026-10-27", "city": "San Francisco"},
        {"title": "AI Engineer Summit", "date": "2026-11-03", "city": "San Francisco"},
    ],
    "emp_dev": [
        {"title": "Acme customer meeting", "date": "2026-10-27", "city": "San Francisco"},
    ],
}

POLICY = {
    "air_cabin_classes": {"economy"},
    "air_cap_usd": 600.00,
    "lodging_nightly_cap_usd": 250.00,
    "auto_approve_limit_usd": 1000.00,
    "blocked_merchants": {"Lucky Star Casino"},
}

TEAM_BUDGETS_REMAINING = {
    "Engineering": {"conferences": 1500.00},
    "Sales": {"conferences": 3000.00},
}

# Past fares per route, for the price check and for counteroffers.
FARE_HISTORY = {
    ("PHL", "SFO"): [430.00, 455.00, 470.00, 495.00, 510.00],
}
ECONOMY_QUOTES = {
    ("PHL", "SFO"): {"merchant": "United Airlines", "amount_usd": 480.00},
}

# Name patterns for well-known merchants, so a purchase cannot be filed under the wrong category.
MERCHANT_CATEGORY_HINTS = {
    "airlines": re.compile(r"\b(airlines?|airways|air lines|jetblue|delta|united|american air|southwest|alaska air)\b", re.I),
    "lodging": re.compile(r"\b(hotels?|marriott|hilton|hyatt|westin|sheraton|airbnb|inn|resort)\b", re.I),
    "ground_transport": re.compile(r"\b(uber|lyft|taxi|hertz|avis|enterprise rent)\b", re.I),
}

GL_ACCOUNTS = {
    "airlines": "6110 Travel - Airfare",
    "lodging": "6120 Travel - Lodging",
    "ground_transport": "6130 Travel - Ground",
    "conferences": "6200 Conferences & Events",
    "meals": "6300 Meals & Entertainment",
    "software": "6400 Software",
    "office_supplies": "6500 Office Supplies",
    "other": "6900 Other",
}
