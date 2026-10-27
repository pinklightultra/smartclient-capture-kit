#!/usr/bin/env node
/**
 * synthetic-phi.js — Deterministic, realistic healthcare data generator for test fixtures.
 *
 * Emits strictly fake Patient, Member, Provider, and Claim rows to safely stress-test
 * safeShot() fail-closed DOM/canvas redaction guards without using any real PHI/PII.
 */

const FIRST_NAMES = [
  "James", "Mary", "Robert", "Patricia", "John", "Jennifer", "Michael", "Linda",
  "David", "Elizabeth", "William", "Barbara", "Richard", "Susan", "Joseph", "Jessica"
];

const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
  "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson"
];

const DIAGNOSES = [
  { code: "E11.9", desc: "Type 2 diabetes mellitus without complications" },
  { code: "I10", desc: "Essential (primary) hypertension" },
  { code: "J45.909", desc: "Unspecified asthma, uncomplicated" },
  { code: "M54.5", desc: "Low back pain" },
  { code: "Z00.00", desc: "Encounter for general adult medical exam" }
];

function generateMember(seed = 1) {
  const fn = FIRST_NAMES[seed % FIRST_NAMES.length];
  const ln = LAST_NAMES[(seed * 7) % LAST_NAMES.length];
  const year = 1950 + (seed % 50);
  const month = String(1 + (seed % 12)).padStart(2, '0');
  const day = String(1 + (seed % 28)).padStart(2, '0');
  const ssnLast4 = String(1000 + (seed * 13) % 9000);
  const medicaidId = `MCD${String(10000000 + seed * 89).slice(0, 8)}`;
  const diag = DIAGNOSES[seed % DIAGNOSES.length];

  return {
    memberName: `${fn} ${ln}`,
    dob: `${month}/${day}/${year}`,
    ssn: `***-**-${ssnLast4}`,
    medicaidId,
    diagnosisCode: diag.code,
    diagnosisDesc: diag.desc,
    mrn: `MRN-${100000 + seed}`,
    phone: `555-01${String(seed % 100).padStart(2, '0')}`,
    balance: `$${(50 + (seed * 17.5) % 800).toFixed(2)}`
  };
}

function generateTableHtml(count = 5) {
  const members = Array.from({ length: count }, (_, i) => generateMember(i + 1));
  const rows = members.map(m => `
    <tr>
      <td>${m.memberName}</td>
      <td>${m.dob}</td>
      <td>${m.mrn}</td>
      <td>${m.medicaidId}</td>
      <td>${m.diagnosisCode}</td>
      <td>${m.diagnosisDesc}</td>
      <td>${m.balance}</td>
    </tr>`).join('');

  return `
    <table class="phi-test-grid" border="1" style="border-collapse: collapse; width: 100%;">
      <thead>
        <tr>
          <th>Member Name</th>
          <th>DOB</th>
          <th>MRN</th>
          <th>Medicaid ID</th>
          <th>Code</th>
          <th>Description</th>
          <th>Balance</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>`;
}

if (require.main === module) {
  const count = parseInt(process.argv[2] || "5", 10);
  console.log(generateTableHtml(count));
}

module.exports = {
  generateMember,
  generateTableHtml,
};
