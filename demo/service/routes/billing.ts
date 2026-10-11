export function processInvoice(invoice: any) {
  return invoice.customer.address.city;
}

export function handleInvoice(data: any) {
  return processInvoice(data);
}
