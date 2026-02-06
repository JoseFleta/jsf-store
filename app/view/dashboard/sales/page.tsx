import StockMovementsPage from "../_components/StockMovementsPage";

export default function SalesPage() {
  return (
    <StockMovementsPage
      movementType="sale"
      pageTitle="Ventas"
      pageSubtitle="Registra salidas de inventario por venta."
    />
  );
}
