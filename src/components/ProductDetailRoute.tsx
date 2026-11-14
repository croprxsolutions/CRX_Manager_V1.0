import { useNavigate, useParams } from 'react-router-dom';
import ProductDetail from '../pages/ProductDetail';
import Button from './ui/Button';

// Postgres rejects anything else as a product id ("invalid input syntax for type uuid"), e.g. /products/group (KI-116).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Like JobDetailRoute.tsx, remount the page when the product id (including "new") changes.
export default function ProductDetailRoute() {
  const { id } = useParams();
  const navigate = useNavigate();
  if (id !== 'new' && !UUID.test(id ?? '')) {
    return (
      <div className="flex flex-col items-center justify-center py-16 space-y-4">
        <p className="text-secondary text-lg">Product not found</p>
        <Button variant="secondary" onClick={() => navigate('/products')}>Back to Products</Button>
      </div>
    );
  }
  return <ProductDetail key={id} />;
}
