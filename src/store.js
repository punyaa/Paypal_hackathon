// Tiny JSON file store. Good enough for a single-instance hackathon app.
import fs from "node:fs";
import path from "node:path";

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { milestones: {} };
    if (file && fs.existsSync(file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(file, "utf8"));
        this.data.milestones ||= {};
      } catch {
        this.data = { milestones: {} };
      }
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list() {
    return Object.values(this.data.milestones).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id) {
    return this.data.milestones[id] || null;
  }

  put(milestone) {
    milestone.updatedAt = new Date().toISOString();
    this.data.milestones[milestone.id] = milestone;
    this.save();
    return milestone;
  }

  reset() {
    this.data = { milestones: {} };
    this.save();
  }
}
