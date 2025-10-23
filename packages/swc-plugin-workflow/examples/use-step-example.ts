// NOTE: These examples should become fixture testing

// Example 1: Function with "use step" directive
async function add(a: number, b: number) {
  'use step';
  return a + b;
}

// Example 2: Arrow function with "use step"
export const multiply = async (x: number, y: number) => {
  'use step';
  return x * y;
};

// Example 3: File-level directive
// In another file:
// "use step";
//
// export async function processOrder(orderId: string) {
//   // Process the order
//   return { status: 'processed', orderId };
// }
//
// export async function sendNotification(userId: string, message: string) {
//   // Send notification
//   return { sent: true };
// }

// Usage
add(1, 2).then((result) => console.log(result));
multiply(3, 4).then((result) => console.log(result));
