import express from "express";
import { searchTransport } from "./transport.controller.js";

const router = express.Router();

router.post("/search", searchTransport);

export default router;
