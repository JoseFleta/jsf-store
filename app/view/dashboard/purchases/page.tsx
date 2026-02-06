import StockMovementsPage from "../_components/StockMovementsPage";

export default function PurchasesPage() {
  return (
    <StockMovementsPage
      movementType="purchase"
      pageTitle="Compras"
      pageSubtitle="Registra entradas de inventario por compra."
      counterpartyLabel="Proveedor"
    />
  );
}
