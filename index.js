const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const CONSUMER_KEY = process.env.CONSUMER_KEY;
const CONSUMER_SECRET = process.env.CONSUMER_SECRET;
const SHORT_CODE = "174379";
const PASSKEY = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
const CALLBACK_URL = process.env.CALLBACK_URL || "https://daraja-server-production.up.railway.app";

async function getAccessToken() {
    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
    const response = await axios.get(
        "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
        { headers: { Authorization: `Basic ${auth}` } }
    );
    console.log("Token response:", response.data);
    return response.data.access_token;
}

app.get("/", (req, res) => {
    res.json({ status: "Daraja server running", time: new Date() });
});

app.options("/stk-push", cors());
app.post("/stk-push", async (req, res) => {
    try {
        const { phone, amount, orderId, description } = req.body;
        console.log("STK request:", { phone, amount, orderId });

        if (!phone || !amount || !orderId) {
            return res.status(400).json({ success: false, message: "Missing fields" });
        }

        let p = phone.replace(/\D/g, "");
        if (p.startsWith("0")) p = "254" + p.slice(1);
        if (p.startsWith("+")) p = p.slice(1);
        if (!p.startsWith("254")) p = "254" + p;
        console.log("Formatted phone:", p);

        const token = await getAccessToken();

        const now = new Date();
        const ts =
            now.getFullYear() +
            String(now.getMonth() + 1).padStart(2, "0") +
            String(now.getDate()).padStart(2, "0") +
            String(now.getHours()).padStart(2, "0") +
            String(now.getMinutes()).padStart(2, "0") +
            String(now.getSeconds()).padStart(2, "0");

        const password = Buffer.from(`${SHORT_CODE}${PASSKEY}${ts}`).toString("base64");

        const payload = {
            BusinessShortCode: SHORT_CODE,
            Password: password,
            Timestamp: ts,
            TransactionType: "CustomerPayBillOnline",
            Amount: Math.ceil(Number(amount)),
            PartyA: p,
            PartyB: SHORT_CODE,
            PhoneNumber: p,
            CallBackURL: `${CALLBACK_URL}/mpesa-callback`,
            AccountReference: String(orderId).substring(0, 12),
            TransactionDesc: String(description || `Order ${orderId}`).substring(0, 13)
        };

        console.log("Payload:", JSON.stringify(payload));

        const r = await axios.post(
            "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
            payload,
            { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
        );

        console.log("Safaricom response:", JSON.stringify(r.data));
        res.json({ success: true, checkoutRequestID: r.data.CheckoutRequestID, message: "STK push sent" });

    } catch (error) {
        const ed = error.response?.data;
        console.error("Error:", JSON.stringify(ed), error.message);
        res.status(500).json({ success: false, message: ed?.errorMessage || error.message, fullError: ed || "" });
    }
});

app.post("/mpesa-callback", async (req, res) => {
    console.log("Callback:", JSON.stringify(req.body));
    res.status(200).send("OK");
});

app.post("/check-payment", async (req, res) => {
    res.json({ success: true, status: "pending", orderId: req.body.orderId });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Daraja server running on port ${PORT}`));
