import { useParams } from 'react-router-dom';
import ProductDetail from '../pages/ProductDetail';

// Like JobDetailRoute.tsx, remount the page when the product id (including "new") changes.
export default function ProductDetailRoute() {
  const { id } = useParams();
  return <ProductDetail key={id} />;
}
