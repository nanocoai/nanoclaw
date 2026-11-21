// SKILL.md's "Check the database password" step; no run-directly guard, so a checkout path with a space still prints.
import { passwordCheck } from './postgres-password.js';

console.log(JSON.stringify(passwordCheck()));
