/** Order status page does not provide shopify.i18n — use extensionLanguage. */
export const translations = {
  en: {
    customizationTitle: "Your Customization",
    styleLabel: "Style",
    keywordsLabel: "Keywords",
    originalPhoto: "Original photo",
    generatedPainting: "Generated painting",
    originalPhotoFull: "Original Photo",
    generatedPaintingFull: "Generated Painting",
    progressHeading: "Where your artwork is",
    progressBody:
      "After checkout, your portrait moves through preview review, hand painting, finishing, and protected shipping. Use Review portrait when a preview is ready for your approval.",
    reviewPortrait: "Review portrait",
    paymentHeading: "Payment status",
    paymentBody:
      "Your order total includes the AI preview, hand painting, and protected shipping. Contact support if a charge looks unexpected.",
    fulfillmentHeading: "Fulfillment & delivery",
    fulfillmentBody:
      "Handmade portraits ship after you approve the final direction. Tracking appears here once the studio hands the piece to the carrier.",
  },
  fr: {
    customizationTitle: "Votre personnalisation",
    styleLabel: "Style",
    keywordsLabel: "Mots-clés",
    originalPhoto: "Photo originale",
    generatedPainting: "Peinture générée",
    originalPhotoFull: "Photo originale",
    generatedPaintingFull: "Peinture générée",
    progressHeading: "Où en est votre œuvre",
    progressBody:
      "Après le paiement, votre portrait passe par la validation de l'aperçu, la peinture à la main, la finition et l'expédition protégée. Utilisez Examiner le portrait lorsqu'un aperçu est prêt.",
    reviewPortrait: "Examiner le portrait",
    paymentHeading: "Statut du paiement",
    paymentBody:
      "Le total de votre commande inclut l'aperçu IA, la peinture à la main et l'expédition protégée. Contactez le support si un montant vous paraît inattendu.",
    fulfillmentHeading: "Expédition et livraison",
    fulfillmentBody:
      "Les portraits peints à la main sont expédiés après votre validation. Le suivi apparaît ici une fois l'œuvre remise au transporteur.",
  },
};

export function t(key) {
  const lang =
    shopify.localization?.extensionLanguage?.value?.isoCode || "en";
  const table = translations[lang] || translations.en;
  return table[key] || translations.en[key] || key;
}
