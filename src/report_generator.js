// Write JSON and Excel discovery reports.
import { writeFile } from "node:fs/promises";
import ExcelJS from "exceljs";

export const FIELDS = [
  "Group ID", "Group Name", "Project ID", "Project Name", "Project URL",
  "Default Branch", "Jenkins Detected", "GitLab CI Detected", "Classification",
  "Jenkins Files", "GitLab CI Files", "Scan Status", "Error Message",
];

// Prefix formula-like strings so spreadsheets do not evaluate them.
function cell(value) {
  if (Array.isArray(value)) value = value.map(String).join("\n");
  if (typeof value === "string" && /^\s*[=+\-@]/.test(value)) return `'${value}`;
  return value;
}

export async function writeReports(report, jsonPath = "results.json", xlsxPath = "results.xlsx") {
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf-8");

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Projects");
  sheet.addRow(FIELDS);
  for (const row of report.projects) sheet.addRow(FIELDS.map((f) => cell(row[f])));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: { row: 1, column: FIELDS.length } };
  FIELDS.forEach((field, i) => {
    sheet.getColumn(i + 1).width = Math.min(Math.max(field.length + 2, 18), 35);
  });

  const statistics = workbook.addWorksheet("Statistics");
  statistics.addRow(["Metric", "Value"]);
  for (const [key, value] of Object.entries(report.statistics)) {
    if (value !== null && typeof value === "object") {
      for (const [name, n] of Object.entries(value)) statistics.addRow([`${key}.${name}`, n]);
    } else statistics.addRow([key, value]);
  }

  const errors = workbook.addWorksheet("Group Errors");
  errors.addRow(["Group ID", "Operation", "Error Message"]);
  for (const e of report.group_errors) {
    errors.addRow([cell(e.group_id), cell(e.operation), cell(e.error)]);
  }
  await workbook.xlsx.writeFile(xlsxPath);
}
