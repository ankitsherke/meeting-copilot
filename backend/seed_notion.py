"""
seed_notion.py
--------------
Creates the "Leap Counsellor — Students" Notion database inside a parent page
and seeds it with 5 student profiles from the PRD.

Required environment variables:
    NOTION_TOKEN          — Notion integration token (secret_...)
    NOTION_PARENT_PAGE_ID — ID of the Notion page that will contain the database

Usage:
    python seed_notion.py

At the end the script prints the database ID so it can be saved to chrome.storage.
"""

import os
import sys
import json
import requests
from dotenv import load_dotenv

load_dotenv()

NOTION_TOKEN = os.environ.get("NOTION_TOKEN")
NOTION_PARENT_PAGE_ID = os.environ.get("NOTION_PARENT_PAGE_ID")
NOTION_VERSION = "2022-06-28"
BASE_URL = "https://api.notion.com/v1"

if not NOTION_TOKEN:
    print("ERROR: NOTION_TOKEN environment variable is not set.")
    sys.exit(1)

if not NOTION_PARENT_PAGE_ID:
    print("ERROR: NOTION_PARENT_PAGE_ID environment variable is not set.")
    sys.exit(1)

HEADERS = {
    "Authorization": f"Bearer {NOTION_TOKEN}",
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def notion_post(endpoint: str, payload: dict) -> dict | None:
    """POST to a Notion API endpoint and return the parsed JSON response."""
    url = f"{BASE_URL}/{endpoint}"
    try:
        response = requests.post(url, headers=HEADERS, json=payload, timeout=30)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.HTTPError as e:
        print(f"  HTTP error {response.status_code}: {response.text}")
        return None
    except requests.exceptions.RequestException as e:
        print(f"  Request error: {e}")
        return None


def rt(text: str) -> list[dict]:
    """Shorthand: build a Notion rich_text array from a plain string."""
    if not text:
        return []
    return [{"type": "text", "text": {"content": text}}]


def select_prop(option_name: str) -> dict:
    """Build a Notion select property value."""
    return {"select": {"name": option_name}}


def multi_select_prop(options: list[str]) -> dict:
    """Build a Notion multi_select property value."""
    return {"multi_select": [{"name": o} for o in options]}


def phone_prop(number: str) -> dict:
    return {"phone_number": number}


def email_prop(address: str) -> dict:
    return {"email": address}


def number_prop(value: int | float) -> dict:
    return {"number": value}


def rich_text_prop(text: str) -> dict:
    return {"rich_text": rt(text)}


def title_prop(text: str) -> dict:
    return {"title": rt(text)}


# ---------------------------------------------------------------------------
# Step 1: Create the database
# ---------------------------------------------------------------------------

DATABASE_SCHEMA = {
    "Name": {"title": {}},
    "Phone": {"phone_number": {}},
    "Email": {"email": {}},
    "Source Platform": {
        "select": {
            "options": [
                {"name": "Google Ads", "color": "blue"},
                {"name": "Instagram", "color": "pink"},
                {"name": "Referral", "color": "green"},
                {"name": "Walk-in", "color": "yellow"},
                {"name": "Organic", "color": "gray"},
            ]
        }
    },
    "Source Campaign": {"rich_text": {}},
    "Initial Interest": {"rich_text": {}},
    "Counsellor": {
        "select": {
            "options": [
                {"name": "Shruti Jain", "color": "purple"},
                {"name": "Neha Sharma", "color": "blue"},
                {"name": "Tanuja Garanagar", "color": "green"},
                {"name": "Jai Garanagar", "color": "orange"},
                {"name": "Sviya Krishnan", "color": "pink"},
            ]
        }
    },
    "Lead Status": {
        "select": {
            "options": [
                {"name": "New", "color": "gray"},
                {"name": "Call 1 Done", "color": "blue"},
                {"name": "Call 2 Done", "color": "yellow"},
                {"name": "Applied", "color": "orange"},
                {"name": "Enrolled", "color": "green"},
            ]
        }
    },
    "Call Count": {"number": {"format": "number"}},
    "Country": {
        "multi_select": {
            "options": [
                {"name": "Australia", "color": "yellow"},
                {"name": "UK", "color": "blue"},
                {"name": "Ireland", "color": "green"},
                {"name": "Germany", "color": "gray"},
                {"name": "UAE", "color": "orange"},
                {"name": "Canada", "color": "red"},
                {"name": "USA", "color": "purple"},
                {"name": "Singapore", "color": "pink"},
                {"name": "New Zealand", "color": "default"},
            ]
        }
    },
    "Intake": {
        "select": {
            "options": [
                {"name": "Sep 2025", "color": "gray"},
                {"name": "Jan 2026", "color": "blue"},
                {"name": "Sep 2026", "color": "green"},
                {"name": "Jan 2027", "color": "yellow"},
            ]
        }
    },
    "Budget": {"rich_text": {}},
    "Preferred Course": {"rich_text": {}},
    "Preferred Degree": {
        "select": {
            "options": [
                {"name": "Bachelors", "color": "blue"},
                {"name": "Masters", "color": "green"},
                {"name": "PhD", "color": "purple"},
                {"name": "Diploma", "color": "yellow"},
                {"name": "Certificate", "color": "orange"},
            ]
        }
    },
    "Preferred Location": {"rich_text": {}},
    "Work Experience (months)": {"number": {"format": "number"}},
    "Backlog": {"number": {"format": "number"}},
    "IELTS Score": {"rich_text": {}},
    "UG Score": {"rich_text": {}},
    "UG Specialisation": {"rich_text": {}},
    "12th Score": {"rich_text": {}},
    "GRE/GMAT Score": {"rich_text": {}},
    "College in Mind": {"rich_text": {}},
    "Profile Summary": {"rich_text": {}},
    "Motivation": {"rich_text": {}},
    "Constraints": {"rich_text": {}},
    "Open Questions": {"rich_text": {}},
    "Counsellor Commitments": {"rich_text": {}},
    "Emotional Notes": {"rich_text": {}},
    "Last Call Summary": {"rich_text": {}},
}


def create_database() -> str | None:
    """Create the Leap Counsellor — Students database and return its ID."""
    print("Creating database: Leap Counsellor — Students ...")

    payload = {
        "parent": {"type": "page_id", "page_id": NOTION_PARENT_PAGE_ID},
        "title": [{"type": "text", "text": {"content": "Leap Counsellor — Students"}}],
        "properties": DATABASE_SCHEMA,
    }

    result = notion_post("databases", payload)
    if result and result.get("id"):
        db_id = result["id"]
        print(f"  Database created. ID: {db_id}")
        return db_id
    else:
        print("  Failed to create database.")
        return None


# ---------------------------------------------------------------------------
# Step 2: Define student profiles
# ---------------------------------------------------------------------------

def build_profiles(db_id: str) -> list[dict]:
    """Return a list of Notion page-creation payloads for all 5 student profiles."""

    profiles = []

    # ------------------------------------------------------------------
    # Profile 1: Samiraj Pawar — fresh Call 1 lead, Instagram
    # No shortlist fields populated.
    # ------------------------------------------------------------------
    profiles.append({
        "parent": {"database_id": db_id},
        "properties": {
            "Name": title_prop("Samiraj Pawar"),
            "Phone": phone_prop("+91 98765 00001"),
            "Email": email_prop("samiraj.pawar@example.com"),
            "Source Platform": select_prop("Instagram"),
            "Source Campaign": rich_text_prop("UK Masters 2026"),
            "Initial Interest": rich_text_prop("Masters in Design UK"),
            "Counsellor": select_prop("Shruti Jain"),
            "Lead Status": select_prop("New"),
            "Call Count": number_prop(0),
        },
    })

    # ------------------------------------------------------------------
    # Profile 2: Yash Mudre — fresh Call 1 lead, Google Ads
    # No shortlist fields populated.
    # ------------------------------------------------------------------
    profiles.append({
        "parent": {"database_id": db_id},
        "properties": {
            "Name": title_prop("Yash Mudre"),
            "Phone": phone_prop("+91 98765 00002"),
            "Email": email_prop("yash.mudre@example.com"),
            "Source Platform": select_prop("Google Ads"),
            "Source Campaign": rich_text_prop("Study in Dubai 2026"),
            "Initial Interest": rich_text_prop("UAE Masters AI/ML/Data Science"),
            "Counsellor": select_prop("Neha Sharma"),
            "Lead Status": select_prop("New"),
            "Call Count": number_prop(0),
        },
    })

    # ------------------------------------------------------------------
    # Profile 3: Jay Nagar — fresh Call 1 lead, Referral
    # No shortlist fields populated.
    # ------------------------------------------------------------------
    profiles.append({
        "parent": {"database_id": db_id},
        "properties": {
            "Name": title_prop("Jay Nagar"),
            "Phone": phone_prop("+91 98765 00003"),
            "Email": email_prop("jay.nagar@example.com"),
            "Source Platform": select_prop("Referral"),
            "Source Campaign": rich_text_prop(""),
            "Initial Interest": rich_text_prop("USA/Canada/Australia MBA or Project Management"),
            "Counsellor": select_prop("Tanuja Garanagar"),
            "Lead Status": select_prop("New"),
            "Call Count": number_prop(0),
        },
    })

    # ------------------------------------------------------------------
    # Profile 4: Lokesh Kumar — Call 1 Done, Walk-in
    # Identity + shortlist + qualitative fields populated.
    # ------------------------------------------------------------------
    profiles.append({
        "parent": {"database_id": db_id},
        "properties": {
            "Name": title_prop("Lokesh Kumar"),
            "Phone": phone_prop("+91 98765 00004"),
            "Email": email_prop("lokesh.kumar@example.com"),
            "Source Platform": select_prop("Walk-in"),
            "Source Campaign": rich_text_prop("Chennai branch referral"),
            "Initial Interest": rich_text_prop("Australia Certificate III Commercial Cookery"),
            "Counsellor": select_prop("Jai Garanagar"),
            "Lead Status": select_prop("Call 1 Done"),
            "Call Count": number_prop(1),
            # Shortlist fields
            "Country": multi_select_prop(["Australia"]),
            "Preferred Course": rich_text_prop("Certificate III in Commercial Cookery"),
            "Preferred Degree": select_prop("Diploma"),
            "Budget": rich_text_prop("₹25–35L"),
            "UG Score": rich_text_prop("B.Com (Computer Applications)"),
            # Qualitative fields
            "Profile Summary": rich_text_prop(
                "Career switcher from IT to culinary. Has 18-month culinary diploma from India. "
                "US visa rejected. Wants to settle in Australia via skilled work visa route."
            ),
            "Open Questions": rich_text_prop(
                "Post-study work visa eligibility for programs under 90 weeks — needs verification "
                "against CRICOS register before finalising shortlist."
            ),
            "Counsellor Commitments": rich_text_prop(
                "1. Schedule call with visa manager (Tarun) to confirm 90-week CRICOS eligibility. "
                "2. Check for New Zealand culinary program options as backup. "
                "3. Share UCB (UK) prospectus for culinary programs as alternative destination."
            ),
            "Emotional Notes": rich_text_prop(
                "Very motivated and clear about culinary career goal. "
                "Transparent about US visa rejection without being prompted — signals honesty and self-awareness. "
                "Open to UK as an alternative destination after counsellor suggested UCB. Approach with enthusiasm for his pivot story."
            ),
        },
    })

    # ------------------------------------------------------------------
    # Profile 5: Ranjana Krishnan — Call 1 Done, Organic
    # Identity + shortlist + qualitative fields populated.
    # ------------------------------------------------------------------
    profiles.append({
        "parent": {"database_id": db_id},
        "properties": {
            "Name": title_prop("Ranjana Krishnan"),
            "Phone": phone_prop("+91 98765 00005"),
            "Email": email_prop("ranjana.krishnan@example.com"),
            "Source Platform": select_prop("Organic"),
            "Source Campaign": rich_text_prop(""),
            "Initial Interest": rich_text_prop("USA MS Computer Science / Robotics"),
            "Counsellor": select_prop("Sviya Krishnan"),
            "Lead Status": select_prop("Call 1 Done"),
            "Call Count": number_prop(1),
            # Shortlist fields
            "Country": multi_select_prop(["USA"]),
            "Preferred Course": rich_text_prop("MS Computer Science / Robotics"),
            "Preferred Degree": select_prop("Masters"),
            "Intake": select_prop("Sep 2026"),
            "College in Mind": rich_text_prop("CMU, Stanford, Princeton"),
            # Qualitative fields
            "Profile Summary": rich_text_prop(
                "Final year B.Tech CS student. Targeting elite US universities for robotics/CS. "
                "Confused between GATE and GRE — has not committed to either exam. "
                "Parents strongly prefer USA and are the primary decision-drivers. "
                "Student herself is NOT fully committed to going abroad."
            ),
            "Open Questions": rich_text_prop(
                "1. Realistic admit chances at CMU/Stanford — honest assessment needed based on profile. "
                "2. GRE requirement status for target universities — some may have waived GRE. "
                "3. Student's own motivation and readiness to be explored further before full counselling investment."
            ),
            "Counsellor Commitments": rich_text_prop(
                "1. Connect with US counsellor for detailed CMU/Stanford admit reality check (scheduled for next call). "
                "2. Share university-specific GRE and profile requirement details for CMU, Stanford, Princeton CS/Robotics."
            ),
            "Emotional Notes": rich_text_prop(
                "Direct quotes from call: \"I wasn't ready for a job right now.\" \"I was in a confusion state.\" "
                "These signal genuine uncertainty and overwhelm — NOT disinterest in studies. "
                "Parents are driving the decision; student has not fully bought in. "
                "Approach with honesty about admission chances — do not use sales pressure. "
                "If her chances at CMU/Stanford are low based on profile, say so clearly and offer realistic alternatives. "
                "Sensitivity around application fee spending — do not suggest scattergun applications."
            ),
            "Constraints": rich_text_prop(
                "Parents driving the decision; student not fully bought in to studying abroad. "
                "Application fee sensitivity — family does not want to spend on low-probability applications. "
                "Has not appeared for GRE yet; exam timeline will affect Sep 2026 application readiness."
            ),
        },
    })

    return profiles


# ---------------------------------------------------------------------------
# Step 3: Seed profiles into the database
# ---------------------------------------------------------------------------

def seed_profiles(db_id: str) -> None:
    """Create all student profile pages in the Notion database."""
    profiles = build_profiles(db_id)
    student_names = [
        "Samiraj Pawar",
        "Yash Mudre",
        "Jay Nagar",
        "Lokesh Kumar",
        "Ranjana Krishnan",
    ]

    print(f"\nSeeding {len(profiles)} student profiles ...")
    for i, (name, profile_payload) in enumerate(zip(student_names, profiles), start=1):
        print(f"  [{i}/{len(profiles)}] Creating profile: {name} ...")
        result = notion_post("pages", profile_payload)
        if result and result.get("id"):
            page_id = result["id"]
            print(f"    Done. Page ID: {page_id}")
        else:
            print(f"    Failed to create profile for {name}. Continuing ...")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("=" * 60)
    print("Leap Scholar — Notion Database Seeder")
    print("=" * 60)
    print(f"Parent Page ID : {NOTION_PARENT_PAGE_ID}")
    print()

    # Step 1: Create the database
    db_id = create_database()
    if not db_id:
        print("\nAborting: database creation failed.")
        sys.exit(1)

    # Step 2: Seed student profiles
    seed_profiles(db_id)

    # Final output
    print()
    print("=" * 60)
    print("Seeding complete.")
    print(f"DATABASE_ID={db_id}")
    print("Save this ID to chrome.storage as 'notionDatabaseId'.")
    print("=" * 60)


if __name__ == "__main__":
    main()
