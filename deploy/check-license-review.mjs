import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function checkLicenseReview(review) {
  if (!["pending", "blocked", "approved"].includes(review.status) || !Array.isArray(review.blockers)) {
    throw new Error("Invalid license review record.");
  }
  if (!review.reviewedAt || !review.evidence) throw new Error("License review requires a date and evidence.");
  return review.status === "approved" && review.blockers.length === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const filename = process.argv[2] || fileURLToPath(new URL("../licenses/review.json", import.meta.url));
    const review = JSON.parse(readFileSync(filename, "utf8"));
    if (checkLicenseReview(review)) {
      console.log("Public redistribution license review: approved.");
    } else {
      console.warn(`WARNING: License review remains pending; publication is not compliance certification. Open items: ${review.blockers.join("; ")}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}