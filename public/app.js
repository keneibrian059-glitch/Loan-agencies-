
const form = document.querySelector("#application-form");
const button = document.querySelector("#submit-button");
const message = document.querySelector("#form-message");

document.querySelector("#year").textContent =
  new Date().getFullYear();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  message.textContent = "Submitting your application…";

  const data = new FormData(form);
  const payload = {
    fullName: data.get("fullName"),
    phone: data.get("phone"),
    email: data.get("email"),
    amount: Number(data.get("amount")),
    monthlyIncome: Number(data.get("monthlyIncome")),
    purpose: data.get("purpose"),
    consent: data.get("consent") === "on"
  };

  let applicationReceived = false;

  try {
    const response = await fetch("/api/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Unable to submit application.");
    }

    applicationReceived = true;

    message.textContent =
      "Application received. Reference: " + result.reference +
      ". Requesting the KSh 50 payment prompt…";

    const paymentResponse = await fetch("/api/stk-push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reference: result.reference,
        phone: payload.phone
      })
    });

    const payment = await paymentResponse.json();

    if (!paymentResponse.ok) {
      throw new Error(
        "Application saved, but payment was not confirmed: " +
        (payment.error || "Please contact support.")
      );
    }

    message.textContent =
      "Application received. " + payment.message +
      " Reference: " + result.reference;
    form.reset();
  } catch (error) {
    message.textContent =
      (applicationReceived ? "Your application is saved. " : "") +
      (error.message || "Connection error. Please try again.");
  } finally {
    button.disabled = false;
  }
});

