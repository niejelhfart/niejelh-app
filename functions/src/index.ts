import express, { Request, Response } from "express";
import Stripe from "stripe";
import { onRequest } from "firebase-functions/v2/https";

const app = express();
app.use(express.json());

// Health check
app.get("/health", (_req: Request, res: Response): void => {
  res.json({ status: "ok" });
});

// Create Stripe Checkout Session
app.post(
  "/create-checkout-session",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

      if (!stripeSecretKey) {
        res.status(500).json({
          error: "Stripe secret key is missing at runtime",
        });
        return;
      }

      const stripe = new Stripe(stripeSecretKey);

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: "10 Fusion Credits",
              },
              unit_amount: 1000,
            },
            quantity: 1,
          },
        ],
        success_url: "http://localhost:5000/success",
        cancel_url: "http://localhost:5000/cancel",
      });

      res.json({ url: session.url });
      return;
    } catch (err) {
      console.error("Checkout error:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Unknown error",
      });
      return;
    }
  }
);
export { syncAdminClaims } from "./syncAdminClaims.js";

// Optional routes
app.get("/success", (_req: Request, res: Response): void => {
  res.send("Payment successful");
});

app.get("/cancel", (_req: Request, res: Response): void => {
  res.send("Payment cancelled");
});

// Export Firebase Function
export const api = onRequest(app);