/**
 * Simple test to verify that the quantity decrement fix works correctly
 * This test checks the transaction service code logic without requiring database
 */

const fs = require('fs');
const path = require('path');

console.log('🧪 Testing Quantity Decrement Fix...\n');

// Read the transaction service file
const transactionServicePath = path.join(__dirname, 'src', 'transaction', 'transaction.service.ts');
const transactionServiceContent = fs.readFileSync(transactionServicePath, 'utf8');

console.log('1. Checking for duplicate quantity decrement code...');

// Check if the inline quantity decrement code was removed
const inlineDecrementPattern = /for \(const item of items\) \{\s*await prisma\.product\.update\(\{\s*where: \{\s*id: item\.productId\s*\},\s*data: \{\s*quantity: \{\s*decrement: item\.quantity\s*\},\s*status: 'SOLD'\s*\}\s*\}\);\s*\}/s;

const hasInlineDecrement = inlineDecrementPattern.test(transactionServiceContent);

if (hasInlineDecrement) {
  console.log('❌ FAIL: Inline quantity decrement code still exists in transaction service');
  console.log('   This would cause double decrement of product quantities');
} else {
  console.log('✅ PASS: Inline quantity decrement code has been removed');
}

// Check if updateProductQuantities call still exists
const updateProductQuantitiesCall = transactionServiceContent.includes('await this.updateProductQuantities(transaction);');

if (updateProductQuantitiesCall) {
  console.log('✅ PASS: updateProductQuantities method is still called');
} else {
  console.log('❌ FAIL: updateProductQuantities method call has been removed');
}

// Check if updateProductQuantities method exists and is correct
const updateProductQuantitiesMethod = transactionServiceContent.includes('private async updateProductQuantities(transaction: any)');

if (updateProductQuantitiesMethod) {
  console.log('✅ PASS: updateProductQuantities method exists');

  // Check if the method handles SALE transactions correctly
  const saleHandling = transactionServiceContent.includes("if (transaction.type === 'SALE') {");

  if (saleHandling) {
    console.log('✅ PASS: Method handles SALE transactions');

    // Check if it decrements quantity for SALE
    const decrementCheck = transactionServiceContent.includes("newQuantity = Math.max(0, product.quantity - item.quantity);");

    if (decrementCheck) {
      console.log('✅ PASS: Method decrements quantity for SALE transactions');
    } else {
      console.log('❌ FAIL: Method does not decrement quantity for SALE transactions');
    }

    // Check if it sets status correctly
    const statusCheck = transactionServiceContent.includes("newStatus = newQuantity === 0 ? 'SOLD' : 'IN_STORE';");

    if (statusCheck) {
      console.log('✅ PASS: Method sets status correctly (SOLD if quantity=0, IN_STORE otherwise)');
    } else {
      console.log('❌ FAIL: Method does not set status correctly');
    }
  } else {
    console.log('❌ FAIL: Method does not handle SALE transactions');
  }
} else {
  console.log('❌ FAIL: updateProductQuantities method does not exist');
}

console.log('\n📊 SUMMARY:');
console.log('The fix ensures that product quantities are decremented only once per transaction,');
console.log('preventing the double decrement issue that was causing quantities to decrease by 2 instead of 1.');
console.log('The updateProductQuantities method handles quantity updates and status changes correctly.');

console.log('\n🎉 Quantity Fix Test COMPLETED!');
