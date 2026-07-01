const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const CONSUMER_KEY = process.env.CONSUMER_KEY;
const CONSUMER_SECRET = process.env.CONSUMER_SECRET;
const SHORT_CODE = process.env.SHORT_CODE || "174379";
const PASSKEY = process.env.PASSKEY || "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
const CALLBACK_URL = process.env.CALLBACK_URL;

// Firebase Admin for updating orders
const admin = require("firebase-admin");
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");

if (!admin.apps.length && serviceAccount.project_id) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

// GET ACCESS TOKEN
async function getAccessToken() {
    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
    const response = await axios.get(
        "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
        { headers: { Authorization: `Basic ${auth}` } }
    );
    return response.data.access_token;
}

// HEALTH CHECK
app.get("/", (req, res) => {
    res.json({ status: "Daraja server running", time: new Date() });
});

// STK PUSH
app.post("/stk-push", async (req, res) => {
    try {
        const { phone, amount, orderId, description } = req.body;

        if (!phone || !amount || !orderId) {
            return res.status(400).json({ success: false, message: "Missing phone, amount or orderId" });
        }

        // Format phone
        let formattedPhone = phone.replace(/\D/g, "");
        if (formattedPhone.startsWith("0")) formattedPhone = "254" + formattedPhone.slice(1);
        if (formattedPhone.startsWith("+")) formattedPhone = formattedPhone.slice(1);
        if (!formattedPhone.startsWith("254")) formattedPhone = "254" + formattedPhone;

        const accessToken = await getAccessToken();

        const now = new Date();
        const timestamp =
            now.getFullYear().toString() +
            String(now.getMonth() + 1).padStart(2, "0") +
            String(now.getDate()).padStart(2, "0") +
            String(now.getHours()).padStart(2, "0") +
            String(now.getMinutes()).padStart(2, "0") +
            String(now.getSeconds()).padStart(2, "0");

        const password = Buffer.from(`${SHORT_CODE}${PASSKEY}${timestamp}`).toString("base64");

        const stkResponse = await axios.post(
            "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
            {
                BusinessShortCode: SHORT_CODE,
                Password: password,
                Timestamp: timestamp,
                TransactionType: "CustomerBuyGoodsOnline",
                Amount: Math.ceil(amount),
                PartyA: formattedPhone,
                PartyB: SHORT_CODE,
                PhoneNumber: formattedPhone,
                CallBackURL: `${CALLBACK_URL}/mpesa-callback`,
                AccountReference: orderId,
                TransactionDesc: description || `Order ${orderId}`
            },
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        res.json({
            success: true,
            checkoutRequestID: stkResponse.data.CheckoutRequestID,
            message: "STK push sent. Check your phone."
        });

    } catch (error) {
        console.error("STK Push error:", error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: error.response?.data?.errorMessage || "STK push failed. Try again."
        });
    }
});

// MPESA CALLBACK
app.post("/mpesa-callback", async (req, res) => {
    try {
        const callbackData = req.body.Body?.stkCallback;
        if (!callbackData) return res.status(200).send("OK");

        const resultCode = callbackData.ResultCode;
        const orderId = callbackData.CallbackMetadata?.Item?.find(i => i.Name === "AccountReference")?.Value;

        console.log(`Callback received - ResultCode: ${resultCode} - Order: ${orderId}`);

        if (admin.apps.length && orderId) {
            const db = admin.firestore();
            const snapshot = await db.collection("orders").where("orderId", "==", orderId).get();

            if (resultCode === 0) {
                const receipt = callbackData.CallbackMetadata?.Item?.find(i => i.Name === "MpesaReceiptNumber")?.Value;
                const amount = callbackData.CallbackMetadata?.Item?.find(i => i.Name === "Amount")?.Value;
                snapshot.forEach(doc => {
                    doc.ref.update({
                        status: "paid",
                        mpesaReceiptNumber: receipt,
                        amountPaid: amount,
                        paidAt: new Date()
                    });
                });
                console.log(`Payment confirmed: ${receipt}`);
            } else {
                snapshot.forEach(doc => {
                    doc.ref.update({ status: "payment_failed" });
                });
                console.log(`Payment failed: ${callbackData.ResultDesc}`);
            }
        }

        res.status(200).send("OK");
    } catch (error) {
        console.error("Callback error:", error);
        res.status(200).send("OK");
    }
});

// CHECK ORDER PAYMENT STATUS
app.post("/check-payment", async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!admin.apps.length) return res.status(500).json({ success: false, message: "Firebase not configured" });

        const db = admin.firestore();
        const snapshot = await db.collection("orders").where("orderId", "==", orderId).get();

        if (snapshot.empty) return res.status(404).json({ success: false, message: "Order not found" });

        const order = snapshot.docs[0].data();
        res.json({
            success: true,
            status: order.status,
            mpesaReceiptNumber: order.mpesaReceiptNumber || null
        });

    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Daraja server running on port ${PORT}`));
