import StockMovementsPage from "../_components/StockMovementsPage";

export default function SalesPage() {
  return (
    <StockMovementsPage
      movementType="sale"
      pageTitle="Sales"
      pageSubtitle="Track inventory outflows from sales."
    />
  );
}
