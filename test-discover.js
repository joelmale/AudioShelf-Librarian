import { MetadataScanner } from "./apps/backend/dist/modules/librarian/services/scanner.js";
import fs from "fs";

const scanner = new MetadataScanner({ PORT: 3050 });
scanner.discoverTargets("/Volumes/Audio/inbox").then(console.log).catch(console.error);
