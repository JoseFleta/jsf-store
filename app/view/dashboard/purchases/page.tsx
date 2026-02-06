import StockMovementsPage from "../_components/StockMovementsPage";

export default function PurchasesPage() {
  return (
    <StockMovementsPage
      movementType="purchase"
      pageTitle="Purchases"
      pageSubtitle="Track inventory inflows from purchases."
    />
  );
}
