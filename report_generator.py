"""Write JSON and Excel discovery reports."""

import json

from openpyxl import Workbook
from openpyxl.utils import get_column_letter

FIELDS = (
    "Group ID", "Group Name", "Project ID", "Project Name", "Project URL",
    "Default Branch", "Jenkins Detected", "GitLab CI Detected", "Classification",
    "Jenkins Files", "GitLab CI Files", "Scan Status", "Error Message",
)


def _cell(value):
    if isinstance(value, list):
        value = "\n".join(str(item) for item in value)
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def write_reports(report, json_path="results.json", xlsx_path="results.xlsx"):
    with open(json_path, "w", encoding="utf-8") as file:
        json.dump(report, file, indent=2, ensure_ascii=False)
        file.write("\n")

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Projects"
    sheet.append(FIELDS)
    for row in report["projects"]:
        sheet.append([_cell(row[field]) for field in FIELDS])
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    for index, field in enumerate(FIELDS, 1):
        sheet.column_dimensions[get_column_letter(index)].width = min(max(len(field) + 2, 18), 35)
    statistics = workbook.create_sheet("Statistics")
    statistics.append(["Metric", "Value"])
    for key, value in report["statistics"].items():
        if isinstance(value, dict):
            for name, count in value.items():
                statistics.append([f"{key}.{name}", count])
        else:
            statistics.append([key, value])
    errors = workbook.create_sheet("Group Errors")
    errors.append(["Group ID", "Operation", "Error Message"])
    for error in report["group_errors"]:
        errors.append([_cell(error["group_id"]), _cell(error["operation"]), _cell(error["error"])])
    workbook.save(xlsx_path)
